/**
 * Connector registry store tests (#1924).
 *
 * What matters here is not the SQL — it is the three properties that make the
 * shadow registry safe to add to a credential path:
 *   1. it writes a REFERENCE (vault field name), never key material;
 *   2. its identity columns come from `CONNECTOR_REGISTRY`, so a row cannot
 *      claim a channel/DID the platform does not serve;
 *   3. every write fails OPEN — a projection error must never fail a seal that
 *      already succeeded, or make a completed revoke look like it failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValues, conflictSets, updateSets, insertMock, updateMock } = vi.hoisted(() => {
  const insertValues: Record<string, unknown>[] = [];
  const conflictSets: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const insertMock = vi.fn(() => ({
    values: (v: Record<string, unknown>) => {
      insertValues.push(v);
      return {
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          conflictSets.push(set);
        },
      };
    },
  }));
  const updateMock = vi.fn(() => ({
    set: (s: Record<string, unknown>) => {
      updateSets.push(s);
      return { where: async () => undefined };
    },
  }));
  return { insertValues, conflictSets, updateSets, insertMock, updateMock };
});

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: { insert: insertMock, update: updateMock },
  connectors: { ownerDid: 'owner_did', provider: 'provider' },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  connectorRegistryId,
  recordConnectorRegistration,
  revokeConnectorRegistration,
  syncConnectorRegistrationScopes,
} from '../connector-registry-store';

const OWNER = 'did:imajin:farmer';
const SEALED_FIELD = `xai-api-key:${OWNER}`;

beforeEach(() => {
  insertValues.length = 0;
  conflictSets.length = 0;
  updateSets.length = 0;
  insertMock.mockClear();
  updateMock.mockClear();
});

// ── Identity ──────────────────────────────────────────────────────────────────

describe('connectorRegistryId', () => {
  /**
   * The 0114 backfill computes the same expression in SQL. If the two ever
   * disagree, the backfill and the application write two rows for one
   * installation and the unique index turns a connect into a 500.
   */
  it('is deterministic per (owner, provider) and distinct across both axes', () => {
    expect(connectorRegistryId(OWNER, 'xai')).toBe(connectorRegistryId(OWNER, 'xai'));
    expect(connectorRegistryId(OWNER, 'xai')).not.toBe(connectorRegistryId(OWNER, 'gemini'));
    expect(connectorRegistryId(OWNER, 'xai')).not.toBe(connectorRegistryId('did:imajin:other', 'xai'));
    expect(connectorRegistryId(OWNER, 'xai')).toMatch(/^conn_[0-9a-f]{24}$/);
  });
});

// ── recordConnectorRegistration ───────────────────────────────────────────────

describe('recordConnectorRegistration', () => {
  it('writes the vault FIELD NAME, never anything that could be key material', async () => {
    await recordConnectorRegistration({ ownerDid: OWNER, provider: 'xai', sealedKeyField: SEALED_FIELD });

    expect(insertValues[0]).toMatchObject({
      id: connectorRegistryId(OWNER, 'xai'),
      ownerDid: OWNER,
      provider: 'xai',
      channel: 'xai',
      connectorDid: 'did:imajin:xai-connector',
      sealedKeyField: SEALED_FIELD,
      status: 'active',
    });
  });

  /**
   * Seal time is before the "grant scopes" step, so writing `[]` here would
   * make a freshly rotated key look like a revocation in the registry.
   */
  it('leaves the scope snapshot alone on re-seal', async () => {
    await recordConnectorRegistration({ ownerDid: OWNER, provider: 'xai', sealedKeyField: SEALED_FIELD });

    expect(conflictSets[0]).not.toHaveProperty('scopes');
    expect(conflictSets[0]).toMatchObject({ status: 'active', revokedAt: null });
  });

  it('records no sealed field for a connector that seals nothing', async () => {
    await recordConnectorRegistration({ ownerDid: OWNER, provider: 'mcp' });

    expect(insertValues[0].sealedKeyField).toBeNull();
  });

  it('refuses to invent identity for a provider the static registry does not know', async () => {
    await recordConnectorRegistration({ ownerDid: OWNER, provider: 'not-a-connector' });

    expect(insertMock).not.toHaveBeenCalled();
  });

  it('fails open when the write throws, so a successful seal is not undone', async () => {
    insertMock.mockImplementationOnce(() => { throw new Error('relation does not exist'); });

    await expect(
      recordConnectorRegistration({ ownerDid: OWNER, provider: 'xai', sealedKeyField: SEALED_FIELD }),
    ).resolves.toBeUndefined();
  });
});

// ── revokeConnectorRegistration ───────────────────────────────────────────────

describe('revokeConnectorRegistration', () => {
  it('marks the row revoked and clears the scope snapshot', async () => {
    await revokeConnectorRegistration(OWNER, 'xai');

    expect(updateSets[0]).toMatchObject({ status: 'revoked', scopes: [] });
    expect(updateSets[0].revokedAt).toBeInstanceOf(Date);
  });

  it('fails open, because the credential grant is already revoked by this point', async () => {
    updateMock.mockImplementationOnce(() => { throw new Error('connection reset'); });

    await expect(revokeConnectorRegistration(OWNER, 'xai')).resolves.toBeUndefined();
  });
});

// ── syncConnectorRegistrationScopes ───────────────────────────────────────────

describe('syncConnectorRegistrationScopes', () => {
  it('upserts the snapshot, so an OAuth connector with no seal step still registers', async () => {
    await syncConnectorRegistrationScopes(OWNER, 'github', ['github:read']);

    expect(insertValues[0]).toMatchObject({
      provider: 'github',
      channel: 'github',
      connectorDid: 'did:imajin:github-connector',
      scopes: ['github:read'],
    });
    expect(conflictSets[0]).toMatchObject({ scopes: ['github:read'] });
  });

  it('records an empty snapshot when the owner publishes no scopes', async () => {
    await syncConnectorRegistrationScopes(OWNER, 'xai', []);

    expect(conflictSets[0]).toMatchObject({ scopes: [] });
  });

  it('fails open, because channel_links is authoritative and was already written', async () => {
    insertMock.mockImplementationOnce(() => { throw new Error('deadlock detected'); });

    await expect(syncConnectorRegistrationScopes(OWNER, 'xai', ['xai:infer'])).resolves.toBeUndefined();
  });

  it('skips a provider the static registry does not know', async () => {
    await syncConnectorRegistrationScopes(OWNER, 'not-a-connector', ['nope:nope']);

    expect(insertMock).not.toHaveBeenCalled();
  });
});
