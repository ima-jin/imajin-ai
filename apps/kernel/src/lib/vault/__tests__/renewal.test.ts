/**
 * Owner-initiated grant issuance (#1535).
 *
 * #1521 made expiry and revocation destroy a grant's key material, which closed
 * a real hole and opened a different one: a grant could only ever be minted at
 * seal time, so any lapse was a permanent lockout. The only way out was to
 * re-enter the plaintext, which the owner usually no longer has.
 *
 * These tests pin the escape route end to end with real crypto: the owner opens
 * their envelope, mints a replacement grant, and the node reads the field again
 * with the ciphertext untouched.
 *
 * The DB is a stateful in-memory double. It cannot read WHERE clauses, so it
 * distinguishes the two grant queries by their projection — `fetchActiveGrant`
 * selects whole rows and must respect expiry, `listRenewableGrants` selects a
 * projection and must not (an expired-but-still-active row is exactly what it
 * reports).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { unwrapFieldKey, wrapFieldKey } from '@imajin/vault-core';
import { crypto as authCrypto } from '@imajin/auth';

type Row = Record<string, unknown>;

const { tmpVaultPath, grantStore, envelopeStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-renewal-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return {
    tmpVaultPath,
    grantStore: new Map<string, Row>(),
    envelopeStore: new Map<string, Row>(),
  };
});

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = { __table: 'grants' };
  const vaultOwnerEnvelopes = { __table: 'envelopes' };
  const vaultGrantRequests = { __table: 'requests' };

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

  function activeGrants(respectExpiry: boolean): Row[] {
    const now = Date.now();
    return [...grantStore.values()].filter((row) => {
      if (row.status !== 'active') return false;
      if (!respectExpiry) return true;
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
          grantStore.set(String(data.id), data);
          return Promise.resolve([]);
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
      select: (projection?: unknown) => ({
        from: (table: { __table?: string }) => {
          const isEnvelopes = table.__table === 'envelopes';
          const all = () => (isEnvelopes ? [...envelopeStore.values()] : [...grantStore.values()]);
          return thenable(all, {
            where: () => ({
              limit: () => {
                if (isEnvelopes) {
                  return Promise.resolve([...envelopeStore.values()].slice(0, 1));
                }
                // Projection ⇒ listRenewableGrants, which must see expired rows.
                return Promise.resolve(activeGrants(projection === undefined).slice(0, 1));
              },
            }),
          });
        },
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

import {
  canonicalizeGrantPayload,
  defaultGrantExpiry,
  expectedGrantVerifier,
  getOwnerEnvelope,
  listRenewableGrants,
  loadAndUnseal,
  sealAndStoreV2,
  vaultService,
} from '../index.js';
import {
  getNodeSigningIdentity,
  getNodeXPublicKey,
  getOwnerXPrivateKey,
  getOwnerXPublicKey,
  _resetSealingCache,
} from '../sealing.js';

const FIELD = 'github-oauth:did:imajin:renewal';
const SECRET = 'gho_renewal_test_token';
const DAY_MS = 24 * 60 * 60 * 1000;

function activeGrant(): Row | undefined {
  return [...grantStore.values()].find((r) => r.status === 'active');
}

function onlyEnvelope(): Row {
  return [...envelopeStore.values()][0]!;
}

/**
 * Do exactly what the owner agent does on renewal: open the envelope with
 * ownerXPriv, re-wrap the recovered field key to the node, sign the canonical
 * payload, and install the grant. No plaintext and no re-seal are involved.
 */
function ownerMintsGrant(
  options: { expiresAt?: Date | null; keyId?: string } = {},
): Row {
  const envelope = onlyEnvelope();
  const identity = getNodeSigningIdentity();

  const fieldKey = unwrapFieldKey(
    { encryptedKey: String(envelope.wrappedKey), nonce: String(envelope.wrappedNonce) },
    String(envelope.senderXPub),
    getOwnerXPrivateKey(),
  );
  const rewrapped = wrapFieldKey(fieldKey, getNodeXPublicKey(), getOwnerXPrivateKey());

  const grantRaw = {
    subject: identity.senderDid,
    grantedTo: identity.senderDid,
    field: FIELD,
    ownerXPub: getOwnerXPublicKey(),
    wrappedKey: rewrapped.encryptedKey,
    wrappedNonce: rewrapped.nonce,
    keyId: options.keyId ?? String(envelope.keyId),
    expiresAt: options.expiresAt ?? null,
  };

  const row: Row = {
    id: 'vdg_renewed',
    ...grantRaw,
    ownerSignature: authCrypto.signSync(canonicalizeGrantPayload(grantRaw), identity.privateKeyHex),
    status: 'active',
    recipientXPub: getNodeXPublicKey(),
    ownerEdPub: identity.senderPubkey,
  };
  grantStore.set('vdg_renewed', row);
  return row;
}

/** Move the current grant out of `active` and blank its key material, as expiry does. */
function lapseCurrentGrant(): void {
  const grant = activeGrant()!;
  grantStore.set(String(grant.id), {
    ...grant,
    status: 'expired',
    wrappedKey: '',
    wrappedNonce: '',
  });
}

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  _resetSealingCache();
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
  delete process.env.VAULT_GRANT_TTL_DAYS;
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
  delete process.env.VAULT_GRANT_TTL_DAYS;
  await unlink(tmpVaultPath).catch(() => undefined);
});

// ── The lockout and the way out ───────────────────────────────────────────────

describe('renewal after a grant lapses', () => {
  it('locks the node out once the grant is gone', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    expect(await loadAndUnseal(FIELD)).toBe(SECRET);

    lapseCurrentGrant();

    // This is the state #1535 exists to escape: ciphertext intact, no way in.
    await expect(loadAndUnseal(FIELD)).rejects.toThrow(/no active delegation grant/i);
  });

  it('restores readability from the envelope alone', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const sealedCid = (await vaultService.peek(FIELD))!.cid;
    lapseCurrentGrant();

    ownerMintsGrant();

    expect(await loadAndUnseal(FIELD)).toBe(SECRET);
    // The point of a renewal: the entry is untouched, so nothing re-signs, no
    // previousCid chain grows, and the plaintext is never re-supplied.
    expect((await vaultService.peek(FIELD))!.cid).toBe(sealedCid);
  });

  it('is rejected when signed by a key the node does not trust', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    lapseCurrentGrant();

    const grant = ownerMintsGrant();
    grantStore.set('vdg_renewed', {
      ...grant,
      ownerSignature: authCrypto.signSync(
        canonicalizeGrantPayload(grant as never),
        randomBytes(32).toString('hex'),
      ),
    });

    await expect(loadAndUnseal(FIELD)).rejects.toThrow(/signature/i);
  });

  it('is rejected when it names a key generation the entry does not use', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    lapseCurrentGrant();

    // Signed over the wrong keyId, not tampered afterwards — otherwise the
    // signature check trips first and the keyId guard is never exercised.
    ownerMintsGrant({ keyId: 'kid:stale' });

    // A grant for another generation cannot decrypt this ciphertext; failing on
    // the keyId says so plainly instead of surfacing a GCM auth error.
    await expect(loadAndUnseal(FIELD)).rejects.toThrow(/keyId/i);
  });

  it('is rejected when it pins a verifier outside the trusted set', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    lapseCurrentGrant();

    const grant = ownerMintsGrant();
    grantStore.set('vdg_renewed', { ...grant, ownerEdPub: 'f'.repeat(64) });

    await expect(loadAndUnseal(FIELD)).rejects.toThrow(/untrusted owner key/i);
  });

  it('expires again on schedule when the renewal carries a TTL', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    lapseCurrentGrant();

    ownerMintsGrant({ expiresAt: new Date(Date.now() - 1000) });

    await expect(loadAndUnseal(FIELD)).rejects.toThrow(/no active delegation grant/i);
  });
});

// ── Worklist ──────────────────────────────────────────────────────────────────

describe('listRenewableGrants', () => {
  it('reports nothing while a long-lived grant is in place', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const nodeDid = getNodeSigningIdentity().senderDid;

    expect(await listRenewableGrants({ nodeDid })).toEqual([]);
  });

  it('reports a field with no active grant as missing', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    lapseCurrentGrant();

    const nodeDid = getNodeSigningIdentity().senderDid;
    const renewable = await listRenewableGrants({ nodeDid });

    expect(renewable).toHaveLength(1);
    expect(renewable[0]!.reason).toBe('missing');
    expect(renewable[0]!.expiresAt).toBeNull();
  });

  it('returns envelope material that actually opens the entry', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    lapseCurrentGrant();

    const nodeDid = getNodeSigningIdentity().senderDid;
    const [renewable] = await listRenewableGrants({ nodeDid });

    // The worklist is useless if the owner cannot act on it without a second
    // round trip, so the envelope travels with the entry that needs it.
    const fieldKey = unwrapFieldKey(
      { encryptedKey: renewable!.wrappedKey, nonce: renewable!.wrappedNonce },
      renewable!.senderXPub,
      getOwnerXPrivateKey(),
    );
    expect(fieldKey).toHaveLength(32);
  });

  it('reports a grant lapsing inside the lookahead as expiring', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const grant = activeGrant()!;
    grantStore.set(String(grant.id), { ...grant, expiresAt: new Date(Date.now() + DAY_MS) });

    const nodeDid = getNodeSigningIdentity().senderDid;
    const renewable = await listRenewableGrants({ nodeDid, withinMs: 7 * DAY_MS });

    expect(renewable).toHaveLength(1);
    expect(renewable[0]!.reason).toBe('expiring');
  });

  it('leaves a grant lapsing beyond the lookahead alone', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const grant = activeGrant()!;
    grantStore.set(String(grant.id), { ...grant, expiresAt: new Date(Date.now() + 90 * DAY_MS) });

    const nodeDid = getNodeSigningIdentity().senderDid;

    expect(await listRenewableGrants({ nodeDid, withinMs: 7 * DAY_MS })).toEqual([]);
  });
});

// ── Supporting primitives ─────────────────────────────────────────────────────

describe('getOwnerEnvelope', () => {
  it('returns the envelope for the current key generation', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const keyId = String(onlyEnvelope().keyId);

    const envelope = await getOwnerEnvelope(FIELD, keyId);
    expect(envelope?.field).toBe(FIELD);
  });
});

describe('defaultGrantExpiry', () => {
  it('does not expire grants by default', () => {
    // Deliberate: expiry destroys key material, and until #1536 renews grants
    // automatically a TTL would silently lock the node out of every v2 secret.
    expect(defaultGrantExpiry()).toBeNull();
  });

  it('applies VAULT_GRANT_TTL_DAYS when set', () => {
    process.env.VAULT_GRANT_TTL_DAYS = '30';
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(defaultGrantExpiry(now)?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('ignores a value that is not a positive number', () => {
    // Failing open (no expiry) beats failing closed here: a bad env var must not
    // turn into an immediate lockout.
    process.env.VAULT_GRANT_TTL_DAYS = 'soon';
    expect(defaultGrantExpiry()).toBeNull();

    process.env.VAULT_GRANT_TTL_DAYS = '0';
    expect(defaultGrantExpiry()).toBeNull();

    process.env.VAULT_GRANT_TTL_DAYS = '-5';
    expect(defaultGrantExpiry()).toBeNull();
  });
});

describe('grant TTL wiring in sealAndStoreV2', () => {
  it('applies the configured default when the caller says nothing', async () => {
    process.env.VAULT_GRANT_TTL_DAYS = '30';

    await sealAndStoreV2(FIELD, SECRET);

    expect(activeGrant()!.expiresAt).toBeInstanceOf(Date);
  });

  it('lets an explicit expiry win over the default', async () => {
    process.env.VAULT_GRANT_TTL_DAYS = '30';
    const explicit = new Date(Date.now() + DAY_MS);

    await sealAndStoreV2(FIELD, SECRET, { expiresAt: explicit });

    expect((activeGrant()!.expiresAt as Date).getTime()).toBe(explicit.getTime());
  });

  it('treats an explicit null as a deliberate never-expires', async () => {
    // `undefined` and `null` must not collapse into each other: one means "use
    // whatever the node is configured for", the other is the caller overriding it.
    process.env.VAULT_GRANT_TTL_DAYS = '30';

    await sealAndStoreV2(FIELD, SECRET, { expiresAt: null });

    expect(activeGrant()!.expiresAt).toBeNull();
  });
});

describe('expectedGrantVerifier', () => {
  it('is the node key in Tier 0', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const entry = (await vaultService.peek(FIELD))!;

    expect(expectedGrantVerifier(entry)).toBe(entry.senderPubkey);
  });

  it('is the configured external owner key in Tier 1', async () => {
    await sealAndStoreV2(FIELD, SECRET);
    const entry = (await vaultService.peek(FIELD))!;

    process.env.VAULT_OWNER_X_PUB = 'a'.repeat(64);
    process.env.VAULT_OWNER_ED_PUB = 'b'.repeat(64);

    expect(expectedGrantVerifier(entry)).toBe('b'.repeat(64));
  });
});
