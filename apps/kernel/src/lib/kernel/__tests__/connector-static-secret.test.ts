/**
 * Tests for the createConnectorStaticSecret factory (#1439).
 *
 * Vault module is mocked so tests exercise delegation, error shapes, and
 * channel_links resolution without crypto operations.
 * Follows the same structure as gemini/connector.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sealGrantMock, loadGranteeMock, revokeGrantMock, existsMock, whereMock } = vi.hoisted(() => ({
  sealGrantMock: vi.fn(),
  loadGranteeMock: vi.fn(),
  revokeGrantMock: vi.fn(),
  existsMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({
  sealAndGrantStaticSecret: sealGrantMock,
  loadAndUnsealByGrantee: loadGranteeMock,
  revokeStaticSecretGrant: revokeGrantMock,
  vaultFieldExists: existsMock,
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: {
    channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes',
  },
}));

import { createConnectorStaticSecret } from '../connector-static-secret';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRINCIPAL = 'did:imajin:chris';
const CONNECTOR_DID = 'did:imajin:test-connector';
const SECRET = 'AIzaSy-SUPER-SECRET-KEY';
const PREFIX = 'test-api-key';

function makeConnector() {
  return createConnectorStaticSecret({
    name: 'test',
    secretPrefix: PREFIX,
    connectorDid: CONNECTOR_DID,
    channel: 'test',
  });
}

function withGrant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function noGrant() {
  whereMock.mockResolvedValue([]);
}

beforeEach(() => {
  sealGrantMock.mockReset().mockResolvedValue({ entry: {}, grantId: 'vdg_mock' });
  loadGranteeMock.mockReset().mockResolvedValue(undefined);
  revokeGrantMock.mockReset().mockResolvedValue(false);
  existsMock.mockReset().mockResolvedValue(false);
  whereMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── secretField ───────────────────────────────────────────────────────────────

describe('secretField', () => {
  it('encodes principalDid in the vault field for per-DID isolation', () => {
    const c = makeConnector();
    expect(c.secretField(PRINCIPAL)).toBe(`${PREFIX}:${PRINCIPAL}`);
  });

  it('different DIDs produce different field names', () => {
    const c = makeConnector();
    expect(c.secretField('did:imajin:alice')).not.toBe(c.secretField('did:imajin:bob'));
  });
});

// ── sealAndGrant ──────────────────────────────────────────────────────────────

describe('sealAndGrant', () => {
  it('delegates to sealAndGrantStaticSecret with the correct field and connectorDid', async () => {
    const c = makeConnector();
    await c.sealAndGrant(PRINCIPAL, SECRET);

    const [field, plaintext, opts] = sealGrantMock.mock.calls[0] as [
      string,
      string,
      { principalDid: string; granteeDid: string; expiresAt: Date | null },
    ];
    expect(field).toBe(c.secretField(PRINCIPAL));
    expect(plaintext).toBe(SECRET);
    expect(opts.principalDid).toBe(PRINCIPAL);
    expect(opts.granteeDid).toBe(CONNECTOR_DID);
    expect(opts.expiresAt).toBeNull();
  });

  it('passes expiresAt when provided', async () => {
    const c = makeConnector();
    const expiresAt = new Date(Date.now() + 3600_000);
    await c.sealAndGrant(PRINCIPAL, SECRET, { expiresAt });

    const [, , opts] = sealGrantMock.mock.calls[0] as [
      string,
      string,
      { expiresAt: Date | null },
    ];
    expect(opts.expiresAt).toEqual(expiresAt);
  });

  it('returns the grantId from the vault primitive', async () => {
    const c = makeConnector();
    const result = await c.sealAndGrant(PRINCIPAL, SECRET);
    expect(result.grantId).toBe('vdg_mock');
  });
});

// ── loadSecret ────────────────────────────────────────────────────────────────

describe('loadSecret', () => {
  it('delegates to loadAndUnsealByGrantee with field and connectorDid', async () => {
    const c = makeConnector();
    await c.loadSecret(PRINCIPAL);

    const [field, granteeDid] = loadGranteeMock.mock.calls[0] as [string, string];
    expect(field).toBe(c.secretField(PRINCIPAL));
    expect(granteeDid).toBe(CONNECTOR_DID);
  });

  it('returns the secret when present', async () => {
    loadGranteeMock.mockResolvedValue(SECRET);
    const c = makeConnector();
    expect(await c.loadSecret(PRINCIPAL)).toBe(SECRET);
  });

  it('returns undefined when no grant or no secret', async () => {
    loadGranteeMock.mockResolvedValue(undefined);
    const c = makeConnector();
    expect(await c.loadSecret(PRINCIPAL)).toBeUndefined();
  });
});

// ── requireSecret ─────────────────────────────────────────────────────────────

describe('requireSecret (fail-closed gate)', () => {
  it('throws test_no_grant when no active channel_links row', async () => {
    noGrant();
    const c = makeConnector();
    await expect(c.requireSecret(PRINCIPAL, 'test:use')).rejects.toThrow(/test_no_grant/);
  });

  it('throws test_no_secret when grant exists but no secret is sealed', async () => {
    withGrant(['test:use']);
    loadGranteeMock.mockResolvedValue(undefined);
    const c = makeConnector();
    await expect(c.requireSecret(PRINCIPAL, 'test:use')).rejects.toThrow(/test_no_secret/);
  });

  it('returns the secret when both channel_links grant and sealed secret are present', async () => {
    withGrant(['test:use']);
    loadGranteeMock.mockResolvedValue(SECRET);
    const c = makeConnector();
    expect(await c.requireSecret(PRINCIPAL, 'test:use')).toBe(SECRET);
  });

  it('is scoped: a different scope does not satisfy the gate', async () => {
    withGrant(['test:other']);
    const c = makeConnector();
    await expect(c.requireSecret(PRINCIPAL, 'test:use')).rejects.toThrow(/test_no_grant/);
  });
});

// ── revokeGrant ───────────────────────────────────────────────────────────────

describe('revokeGrant', () => {
  it('delegates to revokeStaticSecretGrant with field and connectorDid', async () => {
    revokeGrantMock.mockResolvedValue(true);
    const c = makeConnector();
    await c.revokeGrant(PRINCIPAL);

    const [field, granteeDid] = revokeGrantMock.mock.calls[0] as [string, string];
    expect(field).toBe(c.secretField(PRINCIPAL));
    expect(granteeDid).toBe(CONNECTOR_DID);
  });

  it('returns true when a grant was revoked', async () => {
    revokeGrantMock.mockResolvedValue(true);
    expect(await makeConnector().revokeGrant(PRINCIPAL)).toBe(true);
  });

  it('returns false when no active grant existed', async () => {
    revokeGrantMock.mockResolvedValue(false);
    expect(await makeConnector().revokeGrant(PRINCIPAL)).toBe(false);
  });
});

// ── secretSealed ──────────────────────────────────────────────────────────────

describe('secretSealed', () => {
  it('delegates to vaultFieldExists with the per-DID field', async () => {
    existsMock.mockResolvedValue(true);
    const c = makeConnector();
    expect(await c.secretSealed(PRINCIPAL)).toBe(true);
    expect(existsMock).toHaveBeenCalledWith(c.secretField(PRINCIPAL));
  });

  it('returns false when no secret is sealed', async () => {
    existsMock.mockResolvedValue(false);
    expect(await makeConnector().secretSealed(PRINCIPAL)).toBe(false);
  });
});

// ── resolveActiveGrant ────────────────────────────────────────────────────────

describe('resolveActiveGrant', () => {
  it('returns true when an active channel_links row includes the required scope', async () => {
    withGrant(['test:use']);
    expect(await makeConnector().resolveActiveGrant(PRINCIPAL, 'test:use')).toBe(true);
  });

  it('returns false when the row does not include the required scope', async () => {
    withGrant(['other:scope']);
    expect(await makeConnector().resolveActiveGrant(PRINCIPAL, 'test:use')).toBe(false);
  });

  it('returns false when there are no rows at all', async () => {
    noGrant();
    expect(await makeConnector().resolveActiveGrant(PRINCIPAL, 'test:use')).toBe(false);
  });
});
