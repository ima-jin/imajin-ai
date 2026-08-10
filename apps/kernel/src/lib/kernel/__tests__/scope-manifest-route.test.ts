import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Tests for createConnectorScopeManifestRoute factory ─────────────────────
//
// Tests the shared factory directly — verifies OPTIONS/GET/POST behaviour for
// both native connectors (no getExtraFields) and OAuth connectors (with
// getExtraFields). Individual connector route files are thin wiring; this is
// where the logic lives.

// ── Mock next/server ──────────────────────────────────────────────────────────
function mockResponseJson(body: unknown, init?: { status?: number; headers?: unknown }) {
  return { status: init?.status ?? 200, _body: body, json: async () => body };
}
vi.mock('next/server', () => ({
  NextResponse: { json: vi.fn(mockResponseJson) },
  NextRequest: class {},
}));

// ── Mock CORS ─────────────────────────────────────────────────────────────────
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => ({ status: 204 })),
}));

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('@imajin/logger', () => ({ createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn() })) }));

// ── Mock auth ─────────────────────────────────────────────────────────────────
type AppAuthResult =
  | { appAuth: { appDid: string } }
  | { error: string; status: number };

const h = vi.hoisted(() => ({
  authResult: null as { identity: Record<string, unknown> } | { error: string; status: number } | null,
  actingDid: 'did:imajin:owner',
  // Absent by default — every existing test exercises the per-user session path.
  appAuthResult: { error: 'no app auth', status: 401 } as AppAuthResult,
  // Row(s) `registry.apps` would return for the app-auth's appDid.
  registryAppRows: [] as Array<{ ownerDid: string }>,
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: vi.fn(async () => h.appAuthResult),
  requireAuth: vi.fn(async () => h.authResult),
  resolveActingDid: vi.fn(() => h.actingDid),
}));

// ── Mock DB (registry.apps lookup for app-context ownerDid resolution) ────────
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(h.registryAppRows),
        }),
      }),
    }),
  },
  registryApps: { ownerDid: 'ownerDid', appDid: 'appDid' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

// Import factory after mocks
import { createConnectorScopeManifestRoute } from '../scope-manifest-route';

// ── Shared connector stubs ────────────────────────────────────────────────────

function makeStubs(overrides: {
  activeScopes?: string[];
  manifestId?: string | null;
  publishReturn?: string;
  publishThrows?: boolean;
  extraFields?: Record<string, unknown>;
  extraFieldsThrows?: Error;
} = {}) {
  const activeScopes = overrides.activeScopes ?? ['test:read'];
  const manifestId = overrides.manifestId !== undefined ? overrides.manifestId : 'asset_abc';

  function makeGetExtraFields() {
    if (overrides.extraFieldsThrows) {
      return vi.fn(async () => { throw overrides.extraFieldsThrows!; });
    }
    if (overrides.extraFields) {
      return vi.fn(async () => overrides.extraFields!);
    }
    return undefined;
  }

  return {
    findManifestAsset: vi.fn(async () => manifestId ? { id: manifestId } : null),
    readActiveScopes: vi.fn(async () => activeScopes),
    publish: overrides.publishThrows
      ? vi.fn(async () => { throw new Error('db failure'); })
      : vi.fn(async () => overrides.publishReturn ?? 'asset_new'),
    getExtraFields: makeGetExtraFields(),
  };
}

function makeRequest(opts: { body?: unknown } = {}) {
  return {
    headers: { get: () => null },
    json: async () => opts.body,
  } as unknown as import('next/server').NextRequest;
}

const VALID_SCOPES = ['test:read', 'test:write'] as const;

// ── OPTIONS ───────────────────────────────────────────────────────────────────

describe('OPTIONS', () => {
  it('delegates to corsOptions', async () => {
    const { OPTIONS } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs(),
    });
    const { corsOptions } = await import('@/src/lib/kernel/cors');
    const req = makeRequest();
    await OPTIONS(req);
    expect(corsOptions).toHaveBeenCalledWith(req);
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET — native connector (no getExtraFields)', () => {
  beforeEach(() => { h.authResult = { identity: {} }; });

  it('returns 401 when auth fails', async () => {
    h.authResult = { error: 'unauthorized', status: 401 };
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs(),
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns manifestAssetId: null when no manifest exists', async () => {
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs({ manifestId: null, activeScopes: [] }),
    });
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.manifestAssetId).toBeNull();
    expect(body.activeScopes).toEqual([]);
    expect(body.validScopes).toEqual(['test:read', 'test:write']);
    expect(body.tokenSealed).toBeUndefined();
    expect(body.configSealed).toBeUndefined();
  });

  it('returns the manifest asset id and active scopes', async () => {
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES,
      ...makeStubs({ manifestId: 'asset_xyz', activeScopes: ['test:read'] }),
    });
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.manifestAssetId).toBe('asset_xyz');
    expect(body.activeScopes).toEqual(['test:read']);
  });
});

describe('GET — OAuth connector (with getExtraFields)', () => {
  beforeEach(() => { h.authResult = { identity: {} }; });

  it('spreads extra fields into the response', async () => {
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES,
      ...makeStubs({ extraFields: { configSealed: true, tokenSealed: false } }),
    });
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.configSealed).toBe(true);
    expect(body.tokenSealed).toBe(false);
  });

  it('runs getExtraFields in parallel (calls findManifestAsset + readActiveScopes + getExtraFields)', async () => {
    const stubs = makeStubs({ extraFields: { tokenSealed: true } });
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    await GET(makeRequest());
    expect(stubs.findManifestAsset).toHaveBeenCalledOnce();
    expect(stubs.readActiveScopes).toHaveBeenCalledOnce();
    expect(stubs.getExtraFields).toHaveBeenCalledOnce();
  });
});

// A throwing credential probe must not take down the status response — the
// connector card renders its Disconnect button from this endpoint, so a 500 here
// leaves the user with no way to recover through the UI (#1518).
describe('GET — credential probe failure', () => {
  beforeEach(() => { h.authResult = { identity: {} }; });

  it('still returns 200 with scope data when getExtraFields throws', async () => {
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES,
      ...makeStubs({
        manifestId: 'asset_xyz',
        activeScopes: ['test:read'],
        extraFieldsThrows: new Error("Vault entry 'github-config:did:imajin:x' signature verification failed"),
      }),
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifestAssetId).toBe('asset_xyz');
    expect(body.activeScopes).toEqual(['test:read']);
  });

  it('flags the degraded credential status and omits the booleans', async () => {
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES,
      ...makeStubs({ extraFieldsThrows: new Error('vault exploded') }),
    });

    const body = await (await GET(makeRequest())).json();
    expect(body.credentialStatusUnavailable).toBe(true);
    // Absent rather than guessed — the card falls back to its unconfigured state.
    expect(body.configSealed).toBeUndefined();
    expect(body.tokenSealed).toBeUndefined();
  });
});

// ── POST ──────────────────────────────────────────────────────────────────────

describe('POST', () => {
  beforeEach(() => { h.authResult = { identity: {} }; });

  it('returns 401 when auth fails', async () => {
    h.authResult = { error: 'unauthorized', status: 401 };
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs(),
    });
    const res = await POST(makeRequest({ body: { scopes: [] } }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON body', async () => {
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs(),
    });
    const bad = {
      headers: { get: () => null },
      json: async () => { throw new Error('bad json'); },
    } as unknown as import('next/server').NextRequest;
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
  });

  it('returns 400 when scopes is not an array', async () => {
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs(),
    });
    const res = await POST(makeRequest({ body: { scopes: 'test:read' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('array');
  });

  it('returns 400 for unknown scopes (fail-closed)', async () => {
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs(),
    });
    const res = await POST(makeRequest({ body: { scopes: ['test:read', 'unknown:scope'] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('unknown:scope');
    expect(body.error).toContain('Valid scopes');
  });

  it('accepts an empty scopes array (revoke all)', async () => {
    const stubs = makeStubs({ activeScopes: [] });
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    const res = await POST(makeRequest({ body: { scopes: [] } }));
    expect(res.status).toBe(200);
    expect(stubs.publish).toHaveBeenCalledWith(h.actingDid, []);
  });

  it('returns { published, assetId, activeScopes } on success', async () => {
    const stubs = makeStubs({ publishReturn: 'asset_new', activeScopes: ['test:read'] });
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    const res = await POST(makeRequest({ body: { scopes: ['test:read'] } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toBe(true);
    expect(body.assetId).toBe('asset_new');
    expect(body.activeScopes).toEqual(['test:read']);
  });

  it('returns 500 and includes connector name when publish throws', async () => {
    const { POST } = createConnectorScopeManifestRoute({
      name: 'TestConnector', validScopes: VALID_SCOPES, ...makeStubs({ publishThrows: true }),
    });
    const res = await POST(makeRequest({ body: { scopes: ['test:read'] } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('TestConnector');
    expect(body.detail).toContain('db failure');
  });

  it('re-reads active scopes from channel_links after publish (not from publish return)', async () => {
    const stubs = makeStubs({ publishReturn: 'asset_new', activeScopes: ['test:read', 'test:write'] });
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    await POST(makeRequest({ body: { scopes: ['test:read', 'test:write'] } }));
    // readActiveScopes called once at publish time (for GET on POST response)
    expect(stubs.readActiveScopes).toHaveBeenCalledOnce();
  });
});

// ── App-context ownerDid resolution (#1756) ──────────────────────────────────
//
// The app-subsidizes-compute model (#1624) puts keys on the app owner's DID,
// not the logged-in user's. When the request carries app-auth context, GET/POST
// must resolve ownerDid from `registry.apps.ownerDid` instead of the session.

const APP_DID = 'did:imajin:agrifortress-app';
const APP_OWNER_DID = 'did:imajin:agrifortress-owner';

describe('GET — app-context ownerDid resolution', () => {
  beforeEach(() => {
    h.authResult = { identity: {} };
    h.appAuthResult = { error: 'no app auth', status: 401 };
    h.registryAppRows = [];
  });

  it('resolves ownerDid from registry.apps when app-auth succeeds, not the session identity', async () => {
    h.appAuthResult = { appAuth: { appDid: APP_DID } };
    h.registryAppRows = [{ ownerDid: APP_OWNER_DID }];

    const stubs = makeStubs({ manifestId: 'asset_app', activeScopes: ['test:read'] });
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(stubs.findManifestAsset).toHaveBeenCalledWith(APP_OWNER_DID);
    expect(stubs.readActiveScopes).toHaveBeenCalledWith(APP_OWNER_DID);
    expect(stubs.findManifestAsset).not.toHaveBeenCalledWith(h.actingDid);
  });

  it('passes the app owner DID to getExtraFields (e.g. Gemini keySealed check)', async () => {
    h.appAuthResult = { appAuth: { appDid: APP_DID } };
    h.registryAppRows = [{ ownerDid: APP_OWNER_DID }];

    const stubs = makeStubs({ extraFields: { keySealed: true } });
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    await GET(makeRequest());

    expect(stubs.getExtraFields).toHaveBeenCalledWith(APP_OWNER_DID);
  });

  it('returns 404 when the app-auth app is not registered in registry.apps', async () => {
    h.appAuthResult = { appAuth: { appDid: APP_DID } };
    h.registryAppRows = [];

    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...makeStubs(),
    });
    const res = await GET(makeRequest());

    expect(res.status).toBe(404);
  });

  it('falls back to the session identity when no app-auth context is present (unchanged per-user flow)', async () => {
    h.appAuthResult = { error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required', status: 401 };

    const stubs = makeStubs();
    const { GET } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(stubs.findManifestAsset).toHaveBeenCalledWith(h.actingDid);
  });
});

describe('POST — app-context ownerDid resolution', () => {
  beforeEach(() => {
    h.authResult = { identity: {} };
    h.appAuthResult = { error: 'no app auth', status: 401 };
    h.registryAppRows = [];
  });

  it('publishes under the app owner DID when app-auth succeeds', async () => {
    h.appAuthResult = { appAuth: { appDid: APP_DID } };
    h.registryAppRows = [{ ownerDid: APP_OWNER_DID }];

    const stubs = makeStubs({ activeScopes: ['test:read'] });
    const { POST } = createConnectorScopeManifestRoute({
      name: 'Test', validScopes: VALID_SCOPES, ...stubs,
    });
    const res = await POST(makeRequest({ body: { scopes: ['test:read'] } }));

    expect(res.status).toBe(200);
    expect(stubs.publish).toHaveBeenCalledWith(APP_OWNER_DID, ['test:read']);
  });
});
