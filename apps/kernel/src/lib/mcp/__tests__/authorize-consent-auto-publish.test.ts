import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── POST /oauth/authorize — consent commit auto-publish wiring (#1804) ────
//
// The consent-commit handler used to mint an authorization code (and the
// downstream token) without ever touching a connector's scope-manifest, so
// `auth.channel_links` stayed empty until the owner separately visited the
// connector card. These tests drive the REAL POST handler (only its I/O edges
// mocked) and prove:
//   - every consent commit calls the generic projection helper with the
//     resolved owner DID, the consenting app's DID, and the granted scopes;
//   - a projection failure is logged and non-fatal — the authorization code
//     is still minted and returned.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  clientRow: null as Row | null,
  existingAttestation: null as Row | null,
  sessionDid: null as string | null,
  insertedCodes: [] as Row[],
  projectCalls: [] as Row[],
  projectShouldThrow: false,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      headers: { location: undefined as string | undefined },
      json: async () => body,
    })),
    redirect: vi.fn((url: string | URL) => ({
      status: 307,
      headers: { location: String(url) },
      json: async () => ({}),
    })),
  },
  NextRequest: class {},
}));

vi.mock('nanoid', () => ({ nanoid: () => 'testid0000000000' }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

// Table sentinels distinguishable by identity, mirroring how the real
// drizzle schema objects are distinct per table.
const REGISTRY_APPS = { __table: 'registryApps' };
const ATTESTATIONS = { __table: 'attestations' };
const OAUTH_CODES = { __table: 'oauthAuthorizationCodes' };

vi.mock('@/src/db', () => {
  const selectFrom = (table: Row) => ({
    where: () => ({
      limit: async () => {
        if (table === REGISTRY_APPS) return h.clientRow ? [h.clientRow] : [];
        if (table === ATTESTATIONS) return h.existingAttestation ? [h.existingAttestation] : [];
        return [];
      },
    }),
  });
  return {
    db: {
      select: () => ({ from: selectFrom }),
      insert: (table: Row) => ({
        values: async (v: Row) => {
          if (table === OAUTH_CODES) h.insertedCodes.push(v);
          return undefined;
        },
      }),
    },
    registryApps: REGISTRY_APPS,
    attestations: ATTESTATIONS,
    oauthAuthorizationCodes: OAUTH_CODES,
  };
});

vi.mock('@imajin/auth', () => ({
  canonicalize: (v: unknown) => JSON.stringify(v),
  crypto: { signSync: () => 'sig' },
}));

vi.mock('@/app/auth/lib/get-effective-did', () => ({
  getEffectiveDid: async () => ({ sessionDid: h.sessionDid }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false, retryAfter: 0 }),
  getClientIP: () => '127.0.0.1',
}));

vi.mock('@/src/lib/auth/promote-actor', () => ({
  promoteActorOnGrant: vi.fn(async () => undefined),
}));

vi.mock('@/src/lib/kernel/consent-scope-projection', () => ({
  projectConsentedScopes: vi.fn(async (opts: Row) => {
    h.projectCalls.push(opts);
    if (h.projectShouldThrow) throw new Error('projection exploded');
    return [];
  }),
}));

const { POST } = await import('../../../../app/oauth/authorize/route');
const { MCP_SCOPES } = await import('../oauth-config');
const { projectConsentedScopes } = await import('@/src/lib/kernel/consent-scope-projection');

const CALLBACK = 'http://127.0.0.1:33418/oauth/callback';
const CHALLENGE = 'lX0o5JNheAZeS0BYnfmU97oFWi3MiIBiWHpLIqESKI8';
const OWNER = 'did:imajin:owner';
const CLIENT_APP_DID = 'did:imajin:client-app';
const [SCOPE_A, SCOPE_B] = MCP_SCOPES;

type RouteResult = { status: number; headers: { location?: string }; json(): Promise<{ redirect?: string; error?: string }> };

async function callPost(body: Record<string, unknown>) {
  const request = { json: async () => body } as unknown as import('next/server').NextRequest;
  return (await POST(request)) as unknown as RouteResult;
}

function consentBody(overrides: Record<string, unknown> = {}) {
  return {
    client_id: 'app_test',
    redirect_uri: CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope: `${SCOPE_A} ${SCOPE_B}`,
    state: 'probe',
    ...overrides,
  };
}

beforeEach(() => {
  h.sessionDid = OWNER;
  h.existingAttestation = null;
  h.insertedCodes = [];
  h.projectCalls = [];
  h.projectShouldThrow = false;
  h.clientRow = {
    id: 'app_test',
    appDid: CLIENT_APP_DID,
    publicKey: 'pk',
    callbackUrl: CALLBACK,
    requestedScopes: [SCOPE_A, SCOPE_B],
    name: 'Test App',
    logoUrl: null,
  };
  process.env.AUTH_PRIVATE_KEY = 'test-key';
  vi.mocked(projectConsentedScopes).mockClear();
});

describe('POST /oauth/authorize — consent commit auto-publishes granted scopes (#1804)', () => {
  it('calls projectConsentedScopes with the owner DID, the client app DID, and the granted scopes', async () => {
    const res = await callPost(consentBody());
    expect(res.status).toBe(200);

    expect(projectConsentedScopes).toHaveBeenCalledOnce();
    expect(h.projectCalls[0]).toMatchObject({
      ownerDid: OWNER,
      appDid: CLIENT_APP_DID,
      scopes: [SCOPE_A, SCOPE_B],
    });
  });

  it('still mints and returns the authorization code when it does', async () => {
    const res = await callPost(consentBody());
    const { redirect } = await res.json();
    expect(redirect).toBeTruthy();
    expect(new URL(redirect as string).searchParams.get('code')).toBeTruthy();
    expect(h.insertedCodes).toHaveLength(1);
  });

  it('calls the projection again on re-consent (reusing the existing attestation)', async () => {
    h.existingAttestation = { id: 'att_existing', revokedAt: null };
    const res = await callPost(consentBody());
    expect(res.status).toBe(200);
    expect(projectConsentedScopes).toHaveBeenCalledOnce();
  });

  it('is non-fatal: a projection failure still returns a successful consent commit', async () => {
    h.projectShouldThrow = true;
    const res = await callPost(consentBody());
    expect(res.status).toBe(200);
    const { redirect } = await res.json();
    expect(redirect).toBeTruthy();
    expect(h.insertedCodes).toHaveLength(1);
  });
});
