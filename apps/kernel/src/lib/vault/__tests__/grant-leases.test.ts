/**
 * Grants as leases: owner envelopes, crypto-erase, verifier pinning (#1521).
 *
 * These pin the properties that make a delegation grant revocable and a sealed
 * profile portable. Each corresponds to a defect found while auditing #1242:
 *
 *   1. Revocation was a status flag. The wrapped key stayed in the row, so a
 *      revoked grant was still a usable copy of the field key for anyone holding
 *      nodeXPriv and database access. Revocation constrained the code path, not
 *      an attacker — and expiry inherited the same weakness.
 *   2. The owner had no durable copy of the field key by design. What saved it was
 *      incidental (retained fulfilled grant-request rows), so erasing a grant would
 *      have destroyed the last copy.
 *   3. The grant-signature verifier came from a process-wide Tier 1 flag, making
 *      Tier 1 a one-way door: unset the env and every Tier-1-sealed entry stopped
 *      verifying.
 *
 * The DB is a stateful in-memory double so the real crypto path runs end to end.
 * VAULT_PATH is redirected via vi.hoisted() so the module-level vault singleton
 * uses an isolated file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { unwrapFieldKey, unsealSecret, type VaultEntry } from '@imajin/vault-core';

// ── Hoisted setup ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const { tmpVaultPath, grantStore, envelopeStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-grant-leases-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return {
    tmpVaultPath,
    grantStore: new Map<string, Record<string, unknown>>(),
    envelopeStore: new Map<string, Record<string, unknown>>(),
  };
});

// ── DB double ─────────────────────────────────────────────────────────────────
//
// Table-aware, because envelopes gate the erase: a double that answered
// hasOwnerEnvelope from the grant store would make the erase look safe when it is
// not, which is exactly the bug these tests exist to prevent.

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = { __table: 'grants' };
  const vaultOwnerEnvelopes = { __table: 'envelopes' };
  const vaultGrantRequests = { __table: 'requests' };

  const envelopeKey = (data: Row) => `${String(data.field)}:${String(data.keyId)}`;

  function thenableWith<T extends object>(extra: T) {
    const p = Promise.resolve([] as unknown[]);
    return {
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
      ...extra,
    };
  }

  return {
    db: {
      insert: (table: { __table?: string }) => ({
        values: (data: Row) => {
          if (table.__table === 'envelopes') {
            envelopeStore.set(envelopeKey(data), data);
            return thenableWith({
              onConflictDoUpdate: () => {
                envelopeStore.set(envelopeKey(data), data);
                return Promise.resolve([]);
              },
            });
          }
          grantStore.set(String(data.id), data);
          return Promise.resolve([]);
        },
      }),
      update: () => ({
        set: (patch: Row) => ({
          where: () => {
            // Erase targets rows already moved out of 'active'; status changes
            // target the active rows. The double cannot read the WHERE clause, so
            // it models the two shapes the code actually issues.
            const isErase = patch.wrappedKey === '';
            const touched: Row[] = [];
            for (const [id, row] of grantStore) {
              const matches = isErase ? row.status !== 'active' : row.status === 'active';
              if (matches) {
                const next = { ...row, ...patch };
                grantStore.set(id, next);
                touched.push(next);
              }
            }
            return thenableWith({ returning: () => Promise.resolve(touched) });
          },
        }),
      }),
      select: () => ({
        from: (table: { __table?: string }) => ({
          where: () => ({
            limit: () => {
              if (table.__table === 'envelopes') {
                const envelope = [...envelopeStore.values()][0];
                return Promise.resolve(envelope ? [envelope] : []);
              }
              const active = [...grantStore.values()].find((r) => r.status === 'active');
              return Promise.resolve(active ? [active] : []);
            },
          }),
        }),
      }),
    },
    vaultDelegationGrants,
    vaultOwnerEnvelopes,
    vaultGrantRequests,
    channelLinks: {},
  };
});

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { sealAndStoreV2, loadAndUnseal, vaultService, eraseInactiveGrantKeyMaterial } from '../index.js';
import { getNodeXPrivateKey, getOwnerXPrivateKey, _resetSealingCache } from '../sealing.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIELD = 'github-oauth:did:imajin:leases';
const SECRET = 'gho_lease_test_token';

function activeGrant(): Row | undefined {
  return [...grantStore.values()].find((r) => r.status === 'active');
}

function onlyEnvelope(): Row | undefined {
  return [...envelopeStore.values()][0];
}

/** Recover the field key the way the node does: unwrap the grant with nodeXPriv. */
function fieldKeyFromGrant(grant: Row): Buffer {
  return unwrapFieldKey(
    { encryptedKey: String(grant.wrappedKey), nonce: String(grant.wrappedNonce) },
    String(grant.ownerXPub),
    getNodeXPrivateKey(),
  );
}

/** Recover the field key the way the OWNER does: unwrap the envelope with ownerXPriv. */
function fieldKeyFromEnvelope(envelope: Row): Buffer {
  return unwrapFieldKey(
    { encryptedKey: String(envelope.wrappedKey), nonce: String(envelope.wrappedNonce) },
    String(envelope.senderXPub),
    getOwnerXPrivateKey(),
  );
}

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  _resetSealingCache();
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
  await unlink(tmpVaultPath).catch(() => undefined);
});

// ── Owner envelope ────────────────────────────────────────────────────────────

describe('owner envelope', () => {
  it('is written on seal and yields the same field key as the grant', async () => {
    await sealAndStoreV2(FIELD, SECRET);

    const envelope = onlyEnvelope();
    const grant = activeGrant();
    expect(envelope).toBeDefined();
    expect(grant).toBeDefined();

    // Both paths must recover the identical key, or the owner's copy is useless.
    expect(fieldKeyFromEnvelope(envelope!).toString('hex'))
      .toBe(fieldKeyFromGrant(grant!).toString('hex'));
  });

  it('lets the owner decrypt the entry with no grant involved', async () => {
    await sealAndStoreV2(FIELD, SECRET);

    const entry = await vaultService.peek(FIELD);
    const fieldKey = fieldKeyFromEnvelope(onlyEnvelope()!);

    // This is the portability property: ciphertext + envelope + owner key is a
    // complete unit, independent of any grant or of the node holding one.
    expect(unsealSecret(entry as VaultEntry, fieldKey)).toBe(SECRET);
  });

  it('records the ECDH counterparty so the envelope is self-describing', async () => {
    await sealAndStoreV2(FIELD, SECRET);

    const envelope = onlyEnvelope()!;
    // Without senderXPub the owner cannot derive the shared secret, which was the
    // gap that made grant rows un-openable by the owner.
    expect(typeof envelope.senderXPub).toBe('string');
    expect(String(envelope.senderXPub)).toHaveLength(64);
  });

  it('tracks the current key across a re-seal', async () => {
    await sealAndStoreV2(FIELD, 'first');
    const firstKey = fieldKeyFromEnvelope(onlyEnvelope()!).toString('hex');

    await sealAndStoreV2(FIELD, 'second');
    const secondKey = fieldKeyFromEnvelope(onlyEnvelope()!).toString('hex');

    expect(secondKey).not.toBe(firstKey);

    // The envelope must open the CURRENT ciphertext.
    const entry = await vaultService.peek(FIELD);
    expect(unsealSecret(entry as VaultEntry, fieldKeyFromEnvelope(onlyEnvelope()!))).toBe('second');
  });
});

// ── Crypto-erase ──────────────────────────────────────────────────────────────

describe('crypto-erase on grants leaving active', () => {
  it('blanks the wrapped key so a revoked grant is no longer a usable copy', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const grant = activeGrant()!;

    // Before: nodeXPriv recovers the field key straight from the row.
    expect(() => fieldKeyFromGrant(grant)).not.toThrow();

    const revoked = { ...grant, status: 'revoked' };
    grantStore.set(String(grant.id), revoked);
    const erasedIds = await eraseInactiveGrantKeyMaterial([
      { id: String(grant.id), field: String(grant.field), keyId: String(grant.keyId) },
    ]);

    expect(erasedIds).toEqual([grant.id]);
    const after = grantStore.get(String(grant.id))!;
    expect(after.wrappedKey).toBe('');
    expect(after.wrappedNonce).toBe('');
  });

  it('refuses to erase when the owner has no envelope', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const grant = activeGrant()!;

    // Simulate a pre-#1521 grant: no owner copy exists, so the wrapped key is the
    // only copy of the field key and erasing it would destroy the secret.
    envelopeStore.clear();
    grantStore.set(String(grant.id), { ...grant, status: 'revoked' });

    const erasedIds = await eraseInactiveGrantKeyMaterial([
      { id: String(grant.id), field: String(grant.field), keyId: String(grant.keyId) },
    ]);

    expect(erasedIds).toEqual([]);
    expect(grantStore.get(String(grant.id))!.wrappedKey).toBe(grant.wrappedKey);
  });

  it('leaves the secret recoverable by the owner after erase', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const grant = activeGrant()!;
    grantStore.set(String(grant.id), { ...grant, status: 'revoked' });

    await eraseInactiveGrantKeyMaterial([
      { id: String(grant.id), field: String(grant.field), keyId: String(grant.keyId) },
    ]);

    // Erase withdraws the NODE's access. The owner keeps theirs, which is what
    // makes a later renewal or port possible rather than a lockout.
    const entry = await vaultService.peek(FIELD);
    expect(unsealSecret(entry as VaultEntry, fieldKeyFromEnvelope(onlyEnvelope()!))).toBe(SECRET);
  });
});

// ── Verifier pinning ──────────────────────────────────────────────────────────

describe('grant verifier pinning', () => {
  it('pins the verifier on the grant at creation', async () => {
    await sealAndStoreV2(FIELD, SECRET);

    const grant = activeGrant()!;
    // A Tier 0 self-grant is signed by the node, so the pin is the node key.
    expect(typeof grant.ownerEdPub).toBe('string');
    expect(String(grant.ownerEdPub)).toHaveLength(64);
    expect(typeof grant.recipientXPub).toBe('string');
  });

  it('still unseals when the pinned verifier is present', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    expect(await loadAndUnseal(FIELD)).toBe(SECRET);
  });

  it('rejects a grant that pins an untrusted verifier', async () => {
    await sealAndStoreV2(FIELD, SECRET);

    // A tampered row nominating an attacker-controlled key must not be honoured,
    // otherwise the pin becomes a way to self-authorise.
    const grant = activeGrant()!;
    grantStore.set(String(grant.id), { ...grant, ownerEdPub: 'f'.repeat(64) });

    await expect(loadAndUnseal(FIELD)).rejects.toThrow(/untrusted owner key/i);
  });

  it('falls back to the legacy rule for grants written before the pin existed', async () => {
    await sealAndStoreV2(FIELD, SECRET);

    const grant = activeGrant()!;
    grantStore.set(String(grant.id), { ...grant, ownerEdPub: null });

    // Pre-#1521 rows have no pin and must keep working.
    expect(await loadAndUnseal(FIELD)).toBe(SECRET);
  });
});
