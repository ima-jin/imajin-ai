/**
 * Regression test for imajin-ai#1546.
 *
 * `rotateAndStore` used to hardcode v1 node-sealed regardless of the entry's
 * existing custody scheme, via the vault-core `prepareRotationEntry` primitive.
 * `vault-contacts.ts` calls `rotateAndStore` on every update to an existing
 * contact field, which was harmless only because nothing wrote v2 there before
 * #1521. #1521 switched contact writes to `sealAndStoreV2`, which would have
 * made that latent bug live: a contact field sealed as v2 delegation-grant
 * custody would have silently downgraded to v1 on its very next edit.
 *
 * #1546 fixed this at the primitive: `rotateAndStore` now dispatches on the
 * existing entry's custody scheme and delegates to `sealAndStoreV2` itself for
 * v2 fields, so every caller (not just contacts) gets the fix for free.
 *
 * This test exercises the real vault module (crypto + file-backed repository,
 * real `rotateAndStore`) rather than mocking it, so a regression in either
 * `vault-contacts.ts` or the shared `rotateAndStore` primitive would be caught
 * here even if it satisfied the mock-based unit tests in vault-contacts.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';

type Row = Record<string, unknown>;

const { tmpVaultPath, grantStore, envelopeStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-contacts-custody-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return {
    tmpVaultPath,
    grantStore: new Map<string, Row>(),
    envelopeStore: new Map<string, Row>(),
  };
});

// Minimal fake DB: real behaviour for the vault_delegation_grants /
// vault_owner_envelopes tables (mirrors renewal.test.ts), inert no-ops for
// the contact-hash / consent-grant tables vault-contacts.ts also touches.
vi.mock('@/src/db', () => {
  const vaultDelegationGrants = { __table: 'grants' };
  const vaultOwnerEnvelopes = { __table: 'envelopes' };
  const vaultGrantRequests = { __table: 'requests' };
  const contactHashes = { __table: 'contactHashes' };
  const consentGrants = { __table: 'consentGrants' };

  const envelopeKey = (data: Row) => `${String(data.field)}:${String(data.keyId)}`;

  function thenable<T extends object>(rows: () => unknown[], extra: T) {
    const p = Promise.resolve(rows());
    return {
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
      ...extra,
    };
  }

  function activeGrants(): Row[] {
    const now = Date.now();
    return [...grantStore.values()].filter((row) => {
      if (row.status !== 'active') return false;
      const expiresAt = row.expiresAt as Date | null | undefined;
      return !expiresAt || expiresAt.getTime() > now;
    });
  }

  return {
    db: {
      insert: (table: { __table?: string }) => ({
        values: (data: Row) => {
          if (table.__table === 'envelopes') {
            envelopeStore.set(envelopeKey(data), data);
            return thenable(() => [], {
              onConflictDoUpdate: () => {
                envelopeStore.set(envelopeKey(data), data);
                return Promise.resolve([]);
              },
            });
          }
          if (table.__table === 'grants') {
            grantStore.set(String(data.id), data);
            return Promise.resolve([]);
          }
          // contactHashes / consentGrants / requests — inert for this test.
          return thenable(() => [], { onConflictDoUpdate: () => Promise.resolve([]) });
        },
      }),
      update: () => ({
        set: (patch: Row) => ({
          where: () => {
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
            return thenable(() => [], { returning: () => Promise.resolve(touched) });
          },
        }),
      }),
      select: () => ({
        from: (table: { __table?: string }) => {
          if (table.__table === 'envelopes') {
            return thenable(() => [...envelopeStore.values()], {
              where: () => ({ limit: () => Promise.resolve([...envelopeStore.values()].slice(0, 1)) }),
            });
          }
          if (table.__table === 'grants') {
            return thenable(() => [...grantStore.values()], {
              where: () => ({ limit: () => Promise.resolve(activeGrants().slice(0, 1)) }),
            });
          }
          // contactHashes / consentGrants — always empty (no prior state).
          return thenable(() => [], { where: () => ({ limit: () => Promise.resolve([]) }) });
        },
      }),
    },
    vaultDelegationGrants,
    vaultOwnerEnvelopes,
    vaultGrantRequests,
    contactHashes,
    consentGrants,
    channelLinks: {},
  };
});

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

import { processEmailUpdate } from '../vault-contacts';
import { vaultService } from '../../vault';
import { _resetSealingCache } from '../../vault/sealing';

const DID = 'did:imajin:contact-owner';
const FIELD = `contact:email:${DID}`;

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  _resetSealingCache();
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  await unlink(tmpVaultPath).catch(() => undefined);
});

describe('processEmailUpdate custody persistence (imajin-ai#1546 regression)', () => {
  it('seals a contact field as v2 delegation-grant on first write', async () => {
    await processEmailUpdate(DID, 'first@example.com');

    const entry = await vaultService.peek(FIELD);
    expect(entry?.custodyScheme).toBe('delegation-grant');
  });

  it('keeps the field v2 delegation-grant after an update, not v1 node-sealed', async () => {
    await processEmailUpdate(DID, 'first@example.com');
    const firstEntry = await vaultService.peek(FIELD);

    await processEmailUpdate(DID, 'second@example.com');
    const secondEntry = await vaultService.peek(FIELD);

    // The bug this guards against (imajin-ai#1546, now fixed at the
    // rotateAndStore primitive): this update goes through the real
    // rotateAndStore, which must dispatch to sealAndStoreV2 for a v2 entry
    // instead of silently writing custodyScheme absent (v1).
    expect(secondEntry?.custodyScheme).toBe('delegation-grant');
    expect(secondEntry?.cid).not.toBe(firstEntry?.cid);
    expect(secondEntry?.previousCid).toBe(firstEntry?.cid);
  });
});
