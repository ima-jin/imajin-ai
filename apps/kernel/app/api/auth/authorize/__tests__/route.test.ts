import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted; all referenced variables must come from vi.hoisted.

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

vi.mock('nanoid', () => ({ nanoid: () => 'testid0000000000' }));

const {
  mockAppSelectWhere,
  mockAttestationSelectWhere,
  mockDbSelect,
  mockAttestationInsertValues,
  mockDbInsert,
  mockRequireAuth,
  mockPromoteActorOnGrant,
  mockRevokeAttestationOnce,
  ATTESTATIONS_TABLE,
  REGISTRY_APPS_TABLE,
} = vi.hoisted(() => {
  const ATTESTATIONS_TABLE = {
    id: 'attestations.id',
    payload: 'attestations.payload',
    issuerDid: 'attestations.issuerDid',
    subjectDid: 'attestations.subjectDid',
    type: 'attestations.type',
    revokedAt: 'attestations.revokedAt',
  };
  const REGISTRY_APPS_TABLE = {
    id: 'registryApps.id',
    appDid: 'registryApps.appDid',
    publicKey: 'registryApps.publicKey',
    status: 'registryApps.status',
    requestedScopes: 'registryApps.requestedScopes',
    callbackUrl: 'registryApps.callbackUrl',
    name: 'registryApps.name',
    logoUrl: 'registryApps.logoUrl',
  };

  // Two distinct `.select().from(X).where(...)` call sites in the route (app
  // lookup vs. existing-consent lookup) are routed to separate mocks keyed by
  // the table identity passed to `.from(...)`, so each can be configured
  // independently per test.
  const mockAppSelectWhere = vi.fn();
  const mockAttestationSelectWhere = vi.fn();
  const mockDbFrom = vi.fn((table: unknown) =>
    table === ATTESTATIONS_TABLE
      ? { where: mockAttestationSelectWhere }
      : { where: mockAppSelectWhere }
  );
  const mockDbSelect = vi.fn(() => ({ from: mockDbFrom }));

  const mockAttestationInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockDbInsert = vi.fn(() => ({ values: mockAttestationInsertValues }));

  const mockRequireAuth = vi.fn();
  const mockPromoteActorOnGrant = vi.fn().mockResolvedValue(undefined);
  const mockRevokeAttestationOnce = vi.fn().mockResolvedValue({ revoked: true });

  return {
    mockAppSelectWhere,
    mockAttestationSelectWhere,
    mockDbSelect,
    mockAttestationInsertValues,
    mockDbInsert,
    mockRequireAuth,
    mockPromoteActorOnGrant,
    mockRevokeAttestationOnce,
    ATTESTATIONS_TABLE,
    REGISTRY_APPS_TABLE,
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect, insert: mockDbInsert },
  attestations: ATTESTATIONS_TABLE,
  registryApps: REGISTRY_APPS_TABLE,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
}));

vi.mock('@/src/lib/auth/revoke-attestation', () => ({
  revokeAttestationOnce: mockRevokeAttestationOnce,
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  validateScopes: (scopes: string[]) => ({ valid: scopes, invalid: [] }),
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: () => 'sig' },
  // Mirrors packages/auth/src/acting-did.ts precedence (#1717/#1735): a route
  // that regresses to reading `identity.id` directly instead of threading the
  // whole identity through `resolveActingDid` fails these tests.
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown) =>
      handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, correlationId: 'test-cor-id' }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/auth/promote-actor', () => ({
  promoteActorOnGrant: mockPromoteActorOnGrant,
}));

// ─── Subject under test ──────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PERSONAL_DID = 'did:imajin:ryan-personal';
const BUSINESS_DID = 'did:imajin:agrifortress';
const APP_PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

const APP_ROW = {
  id: 'app_4MbCYrndTWiJjMPe',
  appDid: 'did:imajin:wjLjV7nSWNZLTUqnhKRUiBrnGG8mKK7q9WXpNEnV2SM',
  publicKey: APP_PUBLIC_KEY,
  status: 'active',
  requestedScopes: ['profile:read'],
  callbackUrl: 'https://app.example.com/callback',
  name: 'AgriFortress App',
  logoUrl: null,
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/auth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mockRequireAuth.mockResolvedValue({ identity: { id: PERSONAL_DID } });
  mockAppSelectWhere.mockResolvedValue([APP_ROW]);
  mockAttestationSelectWhere.mockResolvedValue([]); // no existing consent by default
  mockAttestationInsertValues.mockResolvedValue(undefined);
  mockPromoteActorOnGrant.mockResolvedValue(undefined);
  mockRevokeAttestationOnce.mockResolvedValue({ revoked: true });
});

describe('POST /api/auth/authorize (#1735)', () => {
  it('promotes the app with its real Ed25519 public key, not a label/sentinel', async () => {
    const res = await POST(makeRequest({ appId: APP_ROW.id, scopes: ['profile:read'] }) as never);

    expect(res.status).toBe(201);
    expect(mockPromoteActorOnGrant).toHaveBeenCalledOnce();
    const input = mockPromoteActorOnGrant.mock.calls[0][0] as Record<string, unknown>;
    expect(input.publicKey).toBe(APP_PUBLIC_KEY);
    expect(input.publicKey).not.toMatch(/^agent_/);
  });

  it('owns the promoted actor under the acting-for (business) DID, not the caller personal DID', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: PERSONAL_DID, actingFor: BUSINESS_DID } });

    const res = await POST(makeRequest({ appId: APP_ROW.id, scopes: ['profile:read'] }) as never);

    expect(res.status).toBe(201);
    const input = mockPromoteActorOnGrant.mock.calls[0][0] as Record<string, unknown>;
    expect(input.ownerDid).toBe(BUSINESS_DID);
  });

  it('owns the promoted actor under the raw session DID when not acting for anyone', async () => {
    const res = await POST(makeRequest({ appId: APP_ROW.id, scopes: ['profile:read'] }) as never);

    expect(res.status).toBe(201);
    const input = mockPromoteActorOnGrant.mock.calls[0][0] as Record<string, unknown>;
    expect(input.ownerDid).toBe(PERSONAL_DID);
  });

  it('still records the app.authorized attestation (regression: grant-of-record unaffected)', async () => {
    await POST(makeRequest({ appId: APP_ROW.id, scopes: ['profile:read'] }) as never);

    expect(mockAttestationInsertValues).toHaveBeenCalledOnce();
    const attestation = mockAttestationInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(attestation.subjectDid).toBe(APP_ROW.appDid);
    expect(attestation.type).toBe('app.authorized');
  });

  it('returns 404 when the app does not exist', async () => {
    mockAppSelectWhere.mockResolvedValue([]);
    const res = await POST(makeRequest({ appId: 'app_missing', scopes: [] }) as never);
    expect(res.status).toBe(404);
    expect(mockPromoteActorOnGrant).not.toHaveBeenCalled();
  });

  it('returns 403 when the app has been revoked', async () => {
    mockAppSelectWhere.mockResolvedValue([{ ...APP_ROW, status: 'revoked' }]);
    const res = await POST(makeRequest({ appId: APP_ROW.id, scopes: [] }) as never);
    expect(res.status).toBe(403);
    expect(mockPromoteActorOnGrant).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/authorize — re-consent supersession (#1795)', () => {
  const EXISTING_ATTESTATION_ID = 'att_existing0000';
  // App must have both scopes registered for the "scopes changed" cases below.
  const APP_ROW_WITH_CONNECTIONS_SCOPE = {
    ...APP_ROW,
    requestedScopes: ['profile:read', 'connections:read'],
  };

  it('reuses the existing attestation when the approved scope set is unchanged', async () => {
    mockAttestationSelectWhere.mockResolvedValue([
      { id: EXISTING_ATTESTATION_ID, payload: { scopes: ['profile:read'] } },
    ]);

    const res = await POST(makeRequest({ appId: APP_ROW.id, scopes: ['profile:read'] }) as never);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.attestationId).toBe(EXISTING_ATTESTATION_ID);
    expect(mockRevokeAttestationOnce).not.toHaveBeenCalled();
    expect(mockAttestationInsertValues).not.toHaveBeenCalled();
    expect(mockPromoteActorOnGrant).toHaveBeenCalledOnce();
  });

  it('revokes the old attestation exactly once and mints a new one when scopes change', async () => {
    mockAppSelectWhere.mockResolvedValue([APP_ROW_WITH_CONNECTIONS_SCOPE]);
    mockAttestationSelectWhere.mockResolvedValue([
      { id: EXISTING_ATTESTATION_ID, payload: { scopes: ['profile:read'] } },
    ]);

    const res = await POST(
      makeRequest({ appId: APP_ROW.id, scopes: ['profile:read', 'connections:read'] }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.attestationId).not.toBe(EXISTING_ATTESTATION_ID);
    expect(mockRevokeAttestationOnce).toHaveBeenCalledOnce();
    expect(mockRevokeAttestationOnce).toHaveBeenCalledWith(
      expect.objectContaining({ attestationId: EXISTING_ATTESTATION_ID }),
    );
    expect(mockAttestationInsertValues).toHaveBeenCalledOnce();
  });

  it('still mints the new attestation when a concurrent request already won the revoke race', async () => {
    mockAppSelectWhere.mockResolvedValue([APP_ROW_WITH_CONNECTIONS_SCOPE]);
    mockAttestationSelectWhere.mockResolvedValue([
      { id: EXISTING_ATTESTATION_ID, payload: { scopes: ['profile:read'] } },
    ]);
    mockRevokeAttestationOnce.mockResolvedValue({ revoked: false });

    const res = await POST(
      makeRequest({ appId: APP_ROW.id, scopes: ['profile:read', 'connections:read'] }) as never,
    );

    expect(res.status).toBe(201);
    expect(mockAttestationInsertValues).toHaveBeenCalledOnce();
  });
});
