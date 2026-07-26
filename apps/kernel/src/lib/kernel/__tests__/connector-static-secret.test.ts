import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  dbSelectMock,
  dbUpdateMock,
  sealAndGrantMock,
  loadAndUnsealByGranteeMock,
  revokeStaticSecretGrantMock,
} = vi.hoisted(() => {
  // DB select chain: .select().from().where().orderBy().limit()
  const dbSelectLimitMock = vi.fn();
  const dbSelectOrderByMock = vi.fn(() => ({ limit: dbSelectLimitMock }));
  const dbSelectWhereMock = vi.fn(() => ({ orderBy: dbSelectOrderByMock }));
  const dbSelectFromMock = vi.fn(() => ({ where: dbSelectWhereMock }));
  const dbSelectMock = vi.fn(() => ({ from: dbSelectFromMock }));

  // DB update chain: .update().set().where()
  const dbUpdateWhereMock = vi.fn().mockResolvedValue(undefined);
  const dbUpdateSetMock = vi.fn(() => ({ where: dbUpdateWhereMock }));
  const dbUpdateMock = vi.fn(() => ({ set: dbUpdateSetMock }));

  const sealAndGrantMock = vi.fn();
  const loadAndUnsealByGranteeMock = vi.fn();
  const revokeStaticSecretGrantMock = vi.fn();

  return {
    dbSelectMock,
    dbSelectLimitMock,
    dbSelectOrderByMock,
    dbSelectWhereMock,
    dbSelectFromMock,
    dbUpdateMock,
    dbUpdateSetMock,
    dbUpdateWhereMock,
    sealAndGrantMock,
    loadAndUnsealByGranteeMock,
    revokeStaticSecretGrantMock,
  };
});

vi.mock('@/src/db', () => ({
  db: { select: dbSelectMock, update: dbUpdateMock },
  vaultDelegationGrants: {},
}));

vi.mock('@/src/lib/vault', () => ({
  sealAndGrantStaticSecret: sealAndGrantMock,
  loadAndUnsealByGrantee: loadAndUnsealByGranteeMock,
  revokeStaticSecretGrant: revokeStaticSecretGrantMock,
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  eq: vi.fn((_col: unknown, _val: unknown) => ({ type: 'eq' })),
  gt: vi.fn((_col: unknown, _val: unknown) => ({ type: 'gt' })),
  isNull: vi.fn((_col: unknown) => ({ type: 'isNull' })),
  like: vi.fn((_col: unknown, _val: unknown) => ({ type: 'like' })),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { createConnectorStaticSecret } from '../connector-static-secret';

const PRINCIPAL = 'did:catalyst:chris';
const GRANTEE = 'did:imajin:agrifortress';
const SECRET = 'sk-test-gemini-key-abc123';
const FIELD = 'test-prefix:did:catalyst:chris';
const GRANT_ID = 'vdg_test_grant';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockSelectRows(rows: unknown[]) {
  // Navigate through the chain: .select().from().where().orderBy().limit()
  const limitMock = vi.fn().mockResolvedValue(rows);
  const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
  const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  dbSelectMock.mockReturnValueOnce({ from: fromMock });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createConnectorStaticSecret', () => {
  const connector = createConnectorStaticSecret({
    name: 'test-secret',
    secretPrefix: 'test-prefix',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sealAndGrantMock.mockReset();
    loadAndUnsealByGranteeMock.mockReset();
    revokeStaticSecretGrantMock.mockReset();
  });

  // ── secretField ────────────────────────────────────────────────────────────

  describe('secretField', () => {
    it('returns prefix:principalDid', () => {
      expect(connector.secretField(PRINCIPAL)).toBe(FIELD);
    });
  });

  // ── sealAndGrant ──────────────────────────────────────────────────────────

  describe('sealAndGrant', () => {
    it('seals the secret and returns the grant id', async () => {
      sealAndGrantMock.mockResolvedValue({ entry: {}, grantId: GRANT_ID });

      const result = await connector.sealAndGrant(PRINCIPAL, GRANTEE, SECRET);

      expect(sealAndGrantMock).toHaveBeenCalledWith(
        FIELD,
        SECRET,
        { principalDid: PRINCIPAL, granteeDid: GRANTEE, expiresAt: null },
      );
      expect(result.grantId).toBe(GRANT_ID);
    });

    it('passes expiresAt when provided', async () => {
      sealAndGrantMock.mockResolvedValue({ entry: {}, grantId: GRANT_ID });
      const expiresAt = new Date('2030-01-01T00:00:00.000Z');

      await connector.sealAndGrant(PRINCIPAL, GRANTEE, SECRET, { expiresAt });

      const callOpts = sealAndGrantMock.mock.calls[0][2] as { expiresAt: Date | null };
      expect(callOpts.expiresAt).toEqual(expiresAt);
    });
  });

  // ── loadSecret ────────────────────────────────────────────────────────────

  describe('loadSecret', () => {
    it('returns the unsealed secret when an active grant exists', async () => {
      const grantRow = { field: FIELD, status: 'active', expiresAt: null, createdAt: new Date() };
      mockSelectRows([grantRow]);
      loadAndUnsealByGranteeMock.mockResolvedValue(SECRET);

      const result = await connector.loadSecret(GRANTEE);

      expect(loadAndUnsealByGranteeMock).toHaveBeenCalledWith(FIELD, GRANTEE);
      expect(result).toBe(SECRET);
    });

    it('throws *_no_credential when no active grant exists', async () => {
      mockSelectRows([]);

      await expect(connector.loadSecret(GRANTEE)).rejects.toThrow('test-secret_no_credential');
      expect(loadAndUnsealByGranteeMock).not.toHaveBeenCalled();
    });

    it('propagates vault errors (revoked grant = VaultDelegationError from vault layer)', async () => {
      const grantRow = { field: FIELD, status: 'active', expiresAt: null, createdAt: new Date() };
      mockSelectRows([grantRow]);
      loadAndUnsealByGranteeMock.mockRejectedValue(new Error('vault_no_grant: revoked'));

      await expect(connector.loadSecret(GRANTEE)).rejects.toThrow('vault_no_grant');
    });
  });

  // ── revokeGrant ───────────────────────────────────────────────────────────

  describe('revokeGrant', () => {
    it('calls revokeStaticSecretGrant with the correct field and granteeDid', async () => {
      revokeStaticSecretGrantMock.mockResolvedValue(undefined);

      await connector.revokeGrant(GRANTEE, PRINCIPAL);

      expect(revokeStaticSecretGrantMock).toHaveBeenCalledWith(FIELD, GRANTEE);
    });
  });
});
