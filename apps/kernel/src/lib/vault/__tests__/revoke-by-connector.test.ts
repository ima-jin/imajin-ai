/**
 * Tests for revokeVaultDelegationGrantsForConnector (#1720).
 *
 * Token-paste connectors (Gemini, Anthropic, GCP) seal their API key as a v2
 * delegation-grant entry that is SELF-granted to the node (see
 * `createConnectorTokenPaste` / `sealAndStoreV2`), not granted to a connector
 * app DID. `revokeStaticSecretGrant` cannot reach these rows because it
 * matches on `(field, grantedTo)` and the connector app DID is never the
 * grantee here — this is the primitive that closes that gap by matching on
 * `field` alone.
 *
 * DB is mocked with the same stateful in-memory grant store used by
 * `static-secret-grant.test.ts`, so the full vault crypto path (encrypt →
 * persist → revoke → fail-closed reload) is exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unlink } from 'node:fs/promises';

type GrantRow = Record<string, unknown> & {
  id: string;
  field: string;
  grantedTo: string;
  status: string;
  wrappedKey: string;
  wrappedNonce: string;
  keyId: string;
  subject: string;
};

const { tmpVaultPath, grantStore, envelopeStore } = vi.hoisted(() => {
   
  const { join } = require('node:path') as typeof import('node:path');
   
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-revoke-by-connector-test-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  const grantStore = new Map<string, GrantRow>();
  const envelopeStore = new Map<string, Record<string, unknown>>();
  return { tmpVaultPath, grantStore, envelopeStore };
});

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = { __table: 'grants', field: 'field', status: 'status' };
  const vaultOwnerEnvelopes = { __table: 'envelopes' };
  const vaultGrantRequests = { __table: 'requests' };

  function makeWhereResult(returningValue: GrantRow[]) {
    const p = Promise.resolve([] as unknown[]);
    return {
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
      returning: () => Promise.resolve(returningValue),
    };
  }

  function insertEnvelope(data: Record<string, unknown>) {
    envelopeStore.set(`${String(data.field)}:${String(data.keyId)}`, data);
  }

  return {
    db: {
      insert: (table: { __table?: string }) => ({
        values: (data: Record<string, unknown>) => {
          if (table.__table === 'envelopes') {
            insertEnvelope(data);
            const p = Promise.resolve([] as unknown[]);
            return {
              then: p.then.bind(p),
              catch: p.catch.bind(p),
              finally: p.finally.bind(p),
              onConflictDoUpdate: () => {
                insertEnvelope(data);
                return Promise.resolve([]);
              },
            };
          }
          if (table.__table === 'requests') {
            return Promise.resolve([]);
          }
          grantStore.set(String(data.id), data as GrantRow);
          return Promise.resolve([]);
        },
      }),
      // `where()` here does not evaluate the actual LIKE/eq predicate — it
      // mirrors the simplification `static-secret-grant.test.ts` already
      // relies on: an erase-shaped patch (wrappedKey === '') targets rows
      // already out of 'active', anything else targets the active ones.
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => {
            const isErase = patch.wrappedKey === '';
            for (const [id, row] of grantStore) {
              const matches = isErase ? row.status !== 'active' : row.status === 'active';
              if (matches) {
                grantStore.set(id, { ...row, ...patch });
              }
            }
            const patched = [...grantStore.values()].filter(
              (r) => r.status === (patch.status ?? 'active'),
            );
            return makeWhereResult(patched);
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
              const found = [...grantStore.values()].find((r) => r.status === 'active');
              return Promise.resolve(found ? [found] : []);
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

vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

import { sealAndStoreV2, loadAndUnseal, revokeVaultDelegationGrantsForConnector } from '../index.js';
import { _resetSealingCache } from '../sealing.js';

const OWNER = 'did:imajin:farmer';
const API_KEY = 'AIzaSy-SUPER-SECRET-KEY';

function geminiField() {
  return `gemini-api-key:${OWNER}`;
}

function onlyActiveGrant(): GrantRow | undefined {
  return [...grantStore.values()].find((r) => r.status === 'active');
}

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  await unlink(tmpVaultPath).catch(() => undefined);
});

describe('revokeVaultDelegationGrantsForConnector', () => {
  it('returns 0 when no active grant exists for the field', async () => {
    expect(await revokeVaultDelegationGrantsForConnector('gemini', OWNER)).toBe(0);
  });

  it('revokes the active self-granted delegation grant sealed via sealAndStoreV2', async () => {
    await sealAndStoreV2(geminiField(), API_KEY);
    expect(onlyActiveGrant()).toBeDefined();

    const revokedCount = await revokeVaultDelegationGrantsForConnector('gemini', OWNER);

    expect(revokedCount).toBe(1);
    expect(onlyActiveGrant()).toBeUndefined();
  });

  it('makes the key fail-closed via loadAndUnseal after revoke', async () => {
    await sealAndStoreV2(geminiField(), API_KEY);
    expect(await loadAndUnseal(geminiField())).toBe(API_KEY);

    await revokeVaultDelegationGrantsForConnector('gemini', OWNER);

    await expect(loadAndUnseal(geminiField())).rejects.toThrow();
  });

  it('erases the wrapped key material on revoke, not just the status', async () => {
    await sealAndStoreV2(geminiField(), API_KEY);
    const before = onlyActiveGrant()!;
    expect(before.wrappedKey.length).toBeGreaterThan(0);

    await revokeVaultDelegationGrantsForConnector('gemini', OWNER);

    const revoked = [...grantStore.values()].find((r) => r.id === before.id)!;
    expect(revoked.status).toBe('revoked');
    expect(revoked.wrappedKey).toBe('');
    expect(revoked.wrappedNonce).toBe('');
  });
});
