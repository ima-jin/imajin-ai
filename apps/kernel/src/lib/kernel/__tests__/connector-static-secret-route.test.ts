/**
 * Tests for the shared static-secret connector route factory (#1439, #1603).
 *
 * The GET handler is the surface an operator reads to decide what to do next, and
 * #1603 gave it a third state. `secretSealed` and `credentialPending` are both
 * false when nothing is stored, but under Tier 1 a freshly sealed credential is
 * `sealed: false, pending: true` — real, stored, and not yet usable. Collapsing
 * that into "not connected" invites re-pasting a key that is already sealed
 * correctly, so these pin the three states apart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  // Mirrors the real precedence in packages/auth/src/acting-did.ts so a route
  // that regresses to reading `identity.id` directly (instead of threading
  // the whole identity through `resolveActingDid`) fails these tests (#1717).
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createConnectorStaticSecretRoutes } from '../connector-static-secret-route';
import type { ConnectorStaticSecret } from '../connector-static-secret';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const BUSINESS_DID = 'did:imajin:agrifortress';
const SECRET = 'warp-agent-key-SUPER-SECRET-VALUE';

/** A connector double; each test sets only what it cares about. */
function makeConnector(overrides: Partial<ConnectorStaticSecret> = {}) {
  return {
    secretField: (did: string) => `test-key:${did}`,
    sealAndGrant: vi.fn(async () => ({ grantId: 'vdg_1', requestId: null })),
    loadSecret: vi.fn(),
    requireSecret: vi.fn(),
    revokeGrant: vi.fn(async () => true),
    secretSealed: vi.fn(async () => false),
    secretPending: vi.fn(async () => false),
    resolveActiveGrant: vi.fn(async () => true),
    ...overrides,
  } as unknown as ConnectorStaticSecret;
}

function routes(connector: ConnectorStaticSecret, getExtraFields?: (did: string) => Promise<Record<string, unknown>>) {
  return createConnectorStaticSecretRoutes({
    name: 'Test',
    connector,
    ...(getExtraFields ? { getExtraFields } : {}),
  });
}

type RouteRequest = Parameters<ReturnType<typeof routes>['GET']>[0];

function makeReq(body?: unknown, opts: { malformed?: boolean } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.malformed) throw new Error('bad json');
      return body;
    },
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
});

// ─── GET: the three credential states ────────────────────────────────────────

describe('GET credential status', () => {
  it('reports a readable credential as sealed and not pending', async () => {
    const connector = makeConnector({
      secretSealed: vi.fn(async () => true),
      secretPending: vi.fn(async () => false),
    } as Partial<ConnectorStaticSecret>);

    const response = await routes(connector).GET(makeReq());

    expect(await response.json()).toMatchObject({ secretSealed: true, credentialPending: false });
  });

  it('reports a Tier-1 seal awaiting the owner agent as pending, not sealed', async () => {
    const connector = makeConnector({
      secretSealed: vi.fn(async () => false),
      secretPending: vi.fn(async () => true),
    } as Partial<ConnectorStaticSecret>);

    const response = await routes(connector).GET(makeReq());

    // The distinguishing case: stored but unusable. `secretSealed` alone cannot
    // express it, which is why #1603 added the second flag.
    expect(await response.json()).toMatchObject({ secretSealed: false, credentialPending: true });
  });

  it('reports nothing stored as neither sealed nor pending', async () => {
    const response = await routes(makeConnector()).GET(makeReq());

    expect(await response.json()).toMatchObject({ secretSealed: false, credentialPending: false });
  });

  it('asks about the acting DID only', async () => {
    const connector = makeConnector();
    await routes(connector).GET(makeReq());

    expect(connector.secretSealed).toHaveBeenCalledWith(OWNER_DID);
    expect(connector.secretPending).toHaveBeenCalledWith(OWNER_DID);
  });

  it('merges connector-specific extra fields', async () => {
    const response = await routes(makeConnector(), async () => ({ modelId: 'auto' })).GET(makeReq());

    expect(await response.json()).toMatchObject({ secretSealed: false, modelId: 'auto' });
  });

  it('returns 401 without touching the vault when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const connector = makeConnector();

    const response = await routes(connector).GET(makeReq());

    expect(response.status).toBe(401);
    expect(connector.secretSealed).not.toHaveBeenCalled();
  });
});

// ─── POST / DELETE ───────────────────────────────────────────────────────────

describe('POST seal', () => {
  it('seals for the acting DID and never echoes the secret', async () => {
    const connector = makeConnector();

    const response = await routes(connector).POST(makeReq({ secret: SECRET }));

    expect(response.status).toBe(201);
    expect(connector.sealAndGrant).toHaveBeenCalledWith(OWNER_DID, SECRET, { expiresAt: null });
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
  });

  /**
   * #1717 regression: sealing a connector key while acting on behalf of a
   * business/app DID (X-Acting-For) must mint the vault field AND the
   * delegation grant's principal against that acting DID, not the caller's
   * raw personal session DID.
   */
  it('seals under the acting-for DID, not the session DID', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID, actingFor: BUSINESS_DID } });
    const connector = makeConnector();

    const response = await routes(connector).POST(makeReq({ secret: SECRET }));

    expect(response.status).toBe(201);
    expect(connector.sealAndGrant).toHaveBeenCalledWith(BUSINESS_DID, SECRET, { expiresAt: null });
  });

  it('succeeds when the grant is still pending (Tier 1)', async () => {
    // grantId: null is a successful seal with authorization outstanding, not a
    // failure the caller should retry.
    const connector = makeConnector({
      sealAndGrant: vi.fn(async () => ({ grantId: null, requestId: 'req-1' })),
    } as unknown as Partial<ConnectorStaticSecret>);

    const response = await routes(connector).POST(makeReq({ secret: SECRET }));

    expect(response.status).toBe(201);
  });

  it.each([
    ['missing', {}],
    ['blank', { secret: '   ' }],
    ['non-string', { secret: 42 }],
  ])('rejects a %s secret without sealing', async (_label, body) => {
    const connector = makeConnector();

    const response = await routes(connector).POST(makeReq(body));

    expect(response.status).toBe(400);
    expect(connector.sealAndGrant).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const response = await routes(makeConnector()).POST(makeReq(undefined, { malformed: true }));
    expect(response.status).toBe(400);
  });

  it('passes a valid expiresAt through and ignores an unparseable one', async () => {
    const connector = makeConnector();
    await routes(connector).POST(makeReq({ secret: SECRET, expiresAt: '2030-01-01T00:00:00.000Z' }));
    expect(connector.sealAndGrant).toHaveBeenCalledWith(OWNER_DID, SECRET, {
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const other = makeConnector();
    await routes(other).POST(makeReq({ secret: SECRET, expiresAt: 'not-a-date' }));
    expect(other.sealAndGrant).toHaveBeenCalledWith(OWNER_DID, SECRET, { expiresAt: null });
  });

  it('reports a sealing failure as 500 rather than claiming success', async () => {
    const connector = makeConnector({
      sealAndGrant: vi.fn(async () => {
        throw new Error('vault down');
      }),
    } as unknown as Partial<ConnectorStaticSecret>);

    const response = await routes(connector).POST(makeReq({ secret: SECRET }));

    expect(response.status).toBe(500);
  });
});

describe('DELETE revoke', () => {
  it('revokes for the acting DID', async () => {
    const connector = makeConnector();

    const response = await routes(connector).DELETE(makeReq());

    expect(response.status).toBe(200);
    expect(connector.revokeGrant).toHaveBeenCalledWith(OWNER_DID);
    expect(await response.json()).toEqual({ revoked: true });
  });

  it('reports false when there was no active grant', async () => {
    const connector = makeConnector({
      revokeGrant: vi.fn(async () => false),
    } as unknown as Partial<ConnectorStaticSecret>);

    expect(await (await routes(connector).DELETE(makeReq())).json()).toEqual({ revoked: false });
  });

  it('returns 401 without revoking when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const connector = makeConnector();

    expect((await routes(connector).DELETE(makeReq())).status).toBe(401);
    expect(connector.revokeGrant).not.toHaveBeenCalled();
  });
});

describe('OPTIONS', () => {
  it('answers CORS pre-flight', async () => {
    expect((await routes(makeConnector()).OPTIONS(makeReq())).status).toBe(204);
  });
});
