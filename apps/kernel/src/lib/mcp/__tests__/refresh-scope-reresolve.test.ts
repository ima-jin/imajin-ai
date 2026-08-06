import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── POST /oauth/token (grant_type=refresh_token) — scope re-resolution ──────
//
// Regression cover for #1630: the refresh grant used to mint BOTH the successor
// access token and the successor refresh token from `record.scope` — the string
// frozen when the ORIGINAL authorization code was issued. A scope added to the
// vocabulary and toggled on afterwards (messages:read, #1393) therefore never
// reached the JWT `scope` claim, so the per-tool gate in server.ts answered
// `insufficient_scope` forever even though the live channel_links gate (Gate 2)
// would have allowed the call.
//
// These tests drive the REAL route handler with only its I/O edges mocked (db,
// jwt minting, rate-limit, logger), so scope resolution runs for real through
// resolveRefreshScopes() against the live MCP scope vocabulary.

const h = vi.hoisted(() => ({
  refreshRow: null as Record<string, unknown> | null,
  attestationRow: null as { revokedAt: Date | null } | null,
  clientRow: null as Record<string, unknown> | null,
  /** Rows the atomic rotation-consume update returns (0 ⇒ lost the race). */
  consumeRows: [] as { id: string }[],
  /** Every row written to auth.oauth_refresh_tokens (the successor). */
  inserted: [] as Record<string, unknown>[],
  /** Every claim set handed to createAppToken (the successor access token). */
  minted: [] as Record<string, unknown>[],
  /** Every `.set()` payload, tagged by table — used to assert revocations. */
  updates: [] as { table: string; values: Record<string, unknown> }[],
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
  NextRequest: class {},
}));

vi.mock('nanoid', () => ({ nanoid: () => 'testid0000000000' }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
  isNull: (col: unknown) => ({ col, isNull: true }),
}));

vi.mock('@/src/db', () => {
  // Table sentinels: the mocked builder dispatches on identity, since the route
  // runs several different queries against three tables in one request.
  const oauthRefreshTokens = { table: 'refresh_tokens' };
  const attestations = { table: 'attestations' };
  const registryApps = { table: 'apps' };
  const oauthAuthorizationCodes = { table: 'authorization_codes' };

  const rowsFor = (t: { table: string }): unknown[] => {
    if (t.table === 'refresh_tokens') return h.refreshRow ? [h.refreshRow] : [];
    if (t.table === 'attestations') return h.attestationRow ? [h.attestationRow] : [];
    if (t.table === 'apps') return h.clientRow ? [h.clientRow] : [];
    return [];
  };

  // `.where()` is awaited directly by the bare UPDATEs and chained into
  // `.returning()` by the rotation consume, so it must be both.
  const whereResult = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), { returning: async () => rows });

  // Flattened builder chain (keeps nesting under the lint bound).
  const limit = (t: { table: string }) => async () => rowsFor(t);
  const selectWhere = (t: { table: string }) => () => ({ limit: limit(t) });
  const from = (t: { table: string }) => ({ where: selectWhere(t) });
  const select = () => ({ from });

  const set = (t: { table: string }) => (values: Record<string, unknown>) => {
    h.updates.push({ table: t.table, values });
    return { where: () => whereResult(t.table === 'refresh_tokens' ? h.consumeRows : []) };
  };
  const update = (t: { table: string }) => ({ set: set(t) });

  const values = (t: { table: string }) => async (row: Record<string, unknown>) => {
    if (t.table === 'refresh_tokens') h.inserted.push(row);
  };
  const insert = (t: { table: string }) => ({ values: values(t) });

  return {
    db: { select, update, insert },
    registryApps,
    attestations,
    oauthRefreshTokens,
    oauthAuthorizationCodes,
  };
});

vi.mock('@/src/lib/auth/jwt', () => ({
  createAppToken: vi.fn(async (claims: Record<string, unknown>) => {
    h.minted.push(claims);
    return 'access.jwt.token';
  }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false, retryAfter: 0 }),
  getClientIP: () => '127.0.0.1',
}));

// Import AFTER mocks. oauth-config stays REAL — exercising the actual
// intersection against the live MCP ceiling is the whole point.
const { POST } = await import('../../../../app/oauth/token/route');
const { MCP_SCOPES } = await import('../oauth-config');

const CLIENT_ID = 'app_test';
const OFF_CEILING = 'totally:not-a-real-scope';
const [SCOPE_A, SCOPE_B, SCOPE_C] = MCP_SCOPES;

type RouteResult = { status: number; json(): Promise<Record<string, unknown>> };

async function callRefresh(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', 'presented-refresh-token');
  form.set('client_id', CLIENT_ID);
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  const request = {
    formData: async () => form,
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest;
  return (await POST(request)) as unknown as RouteResult;
}

/** The `scope` claim on the successor ACCESS token (Gate 1 reads this). */
function mintedScope(): string {
  expect(h.minted).toHaveLength(1);
  return h.minted[0].scope as string;
}

/** The `scope` column stored on the successor REFRESH token. */
function successorScope(): string {
  expect(h.inserted).toHaveLength(1);
  return h.inserted[0].scope as string;
}

beforeEach(() => {
  h.inserted = [];
  h.minted = [];
  h.updates = [];
  h.consumeRows = [{ id: 'ort_old' }];
  h.attestationRow = { revokedAt: null };
  h.refreshRow = {
    id: 'ort_old',
    tokenHash: 'hash',
    clientId: CLIENT_ID,
    userDid: 'did:imajin:owner',
    // Frozen at original-authorization time: only SCOPE_A.
    scope: SCOPE_A,
    attestationId: 'att_test',
    revokedAt: null,
    lastUsedAt: null,
    rotatedTo: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [SCOPE_A] };
});

describe('fixture sanity', () => {
  it('has at least three MCP scopes to exercise', () => {
    expect(MCP_SCOPES.length).toBeGreaterThanOrEqual(3);
  });
});

// Also serves as the regression guard for the #1647 consent-timeout scenario:
// a tool call clears Gate 1 (token scope) and Gate 2 (channel_links grant), but
// the MCP client's approval prompt times out client-side. Before the retry the
// client refreshes its token — and the successor token must carry the scopes
// from the LIVE `requestedScopes`, not the frozen `record.scope`. The fixtures
// below encode exactly that: `record.scope` holds only SCOPE_A while the client
// registration already carries SCOPE_A + SCOPE_B, so a refresh that regressed to
// the frozen string would silently drop SCOPE_B and fail the retry at Gate 1.
describe('POST /oauth/token refresh — newly registered scope reaches the token (#1630)', () => {
  beforeEach(() => {
    // The scope was toggled on AFTER the original OAuth dance.
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [SCOPE_A, SCOPE_B] };
  });

  it('includes the new scope in the response scope string', async () => {
    const res = await callRefresh();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scope: `${SCOPE_A} ${SCOPE_B}` });
  });

  it('includes the new scope in the successor ACCESS token claim (Gate 1 source)', async () => {
    await callRefresh();
    // The regression: this used to be the frozen `${SCOPE_A}` forever.
    expect(mintedScope()).toBe(`${SCOPE_A} ${SCOPE_B}`);
  });

  it('stores the re-resolved scope on the successor REFRESH token', async () => {
    await callRefresh();
    expect(successorScope()).toBe(`${SCOPE_A} ${SCOPE_B}`);
  });

  it('does not mint from the frozen record.scope', async () => {
    await callRefresh();
    expect(mintedScope()).not.toBe(SCOPE_A);
    expect(successorScope()).not.toBe(SCOPE_A);
  });

  it('survives a consent-timeout retry: scope absent from record.scope, present in requestedScopes (#1647)', async () => {
    // Precondition — the frozen authorization-code scope really is missing the
    // scope the retry needs; without this the assertion below proves nothing.
    expect(h.refreshRow?.scope).toBe(SCOPE_A);
    expect(String(h.refreshRow?.scope)).not.toContain(SCOPE_B);
    expect(h.clientRow?.requestedScopes).toContain(SCOPE_B);

    await callRefresh();

    // The retry after the timed-out approval prompt clears Gate 1.
    expect(mintedScope().split(' ')).toContain(SCOPE_B);
    expect(successorScope().split(' ')).toContain(SCOPE_B);
  });

  it('keeps the rest of the rotation contract intact', async () => {
    const body = await (await callRefresh()).json();
    expect(body.access_token).toBe('access.jwt.token');
    expect(body.token_type).toBe('Bearer');
    expect(body.refresh_token).toEqual(expect.any(String));
    // rotatedTo links the lineage for reuse audit.
    expect(h.updates.some((u) => u.values.rotatedTo !== undefined)).toBe(true);
  });
});

describe('POST /oauth/token refresh — de-registered scope drops out', () => {
  beforeEach(() => {
    // Originally granted two scopes; SCOPE_B has since been removed from the
    // client's registration.
    h.refreshRow = { ...h.refreshRow, scope: `${SCOPE_A} ${SCOPE_B}` };
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [SCOPE_A] };
  });

  it('narrows the response scope to the current registration', async () => {
    expect(await (await callRefresh()).json()).toMatchObject({ scope: SCOPE_A });
  });

  it('drops the removed scope from the successor ACCESS token', async () => {
    await callRefresh();
    expect(mintedScope()).toBe(SCOPE_A);
    expect(mintedScope()).not.toContain(SCOPE_B);
  });

  it('drops the removed scope from the successor REFRESH token', async () => {
    await callRefresh();
    expect(successorScope()).toBe(SCOPE_A);
    expect(successorScope()).not.toContain(SCOPE_B);
  });
});

describe('POST /oauth/token refresh — never widens past the MCP ceiling', () => {
  it('drops a registry scope outside MCP_SCOPE_SET', async () => {
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [SCOPE_A, OFF_CEILING] };
    await callRefresh();
    expect(mintedScope()).toBe(SCOPE_A);
    expect(successorScope()).toBe(SCOPE_A);
  });

  it('never grants a scope the client did not register, even if in the ceiling', async () => {
    h.refreshRow = { ...h.refreshRow, scope: SCOPE_A };
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [SCOPE_A] };
    await callRefresh();
    expect(mintedScope()).toBe(SCOPE_A);
    expect(mintedScope()).not.toContain(SCOPE_B);
    expect(mintedScope()).not.toContain(SCOPE_C);
  });

  it('never carries a frozen off-ceiling scope forward from record.scope', async () => {
    // A stale lineage minted before the scope was retired from the vocabulary.
    h.refreshRow = { ...h.refreshRow, scope: `${SCOPE_A} ${OFF_CEILING}` };
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [SCOPE_A] };
    await callRefresh();
    expect(mintedScope()).toBe(SCOPE_A);
    expect(successorScope()).toBe(SCOPE_A);
  });

  it('de-duplicates a registry row holding the same scope twice', async () => {
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [SCOPE_A, SCOPE_A] };
    await callRefresh();
    expect(mintedScope()).toBe(SCOPE_A);
  });
});

describe('POST /oauth/token refresh — no grantable scopes fails closed', () => {
  it('returns invalid_scope when the registration was emptied', async () => {
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [] };
    const res = await callRefresh();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('returns invalid_scope when requestedScopes is null (legacy row)', async () => {
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: null };
    expect(await (await callRefresh()).json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('returns invalid_scope when every registered scope left the ceiling', async () => {
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [OFF_CEILING] };
    expect(await (await callRefresh()).json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('mints nothing and does NOT burn the presented refresh token', async () => {
    h.clientRow = { appDid: 'did:imajin:mcp-test', requestedScopes: [] };
    await callRefresh();
    expect(h.minted).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
    // Scope resolution runs BEFORE the rotation consume, so nothing was revoked.
    expect(h.updates).toHaveLength(0);
  });
});

describe('POST /oauth/token refresh — earlier gates unchanged', () => {
  it('requires refresh_token and client_id', async () => {
    const form = new FormData();
    form.set('grant_type', 'refresh_token');
    const request = {
      formData: async () => form,
      headers: { get: () => null },
    } as unknown as import('next/server').NextRequest;
    const res = (await POST(request)) as unknown as RouteResult;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects an unknown refresh token', async () => {
    h.refreshRow = null;
    expect(await (await callRefresh()).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('revokes the whole grant on reuse of a rotated-out token', async () => {
    h.refreshRow = { ...h.refreshRow, revokedAt: new Date() };
    const res = await callRefresh();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    // Both the lineage and the backing attestation are revoked.
    expect(h.updates.map((u) => u.table)).toEqual(['refresh_tokens', 'attestations']);
    expect(h.minted).toHaveLength(0);
  });

  it('rejects an expired refresh token', async () => {
    h.refreshRow = { ...h.refreshRow, expiresAt: new Date(Date.now() - 1) };
    expect(await (await callRefresh()).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a revoked attestation before touching scope', async () => {
    h.attestationRow = { revokedAt: new Date() };
    expect(await (await callRefresh()).json()).toMatchObject({ error: 'invalid_grant' });
    expect(h.minted).toHaveLength(0);
  });

  it('rejects an inactive client', async () => {
    h.clientRow = null;
    const res = await callRefresh();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('denies when the rotation consume loses the race', async () => {
    h.consumeRows = [];
    expect(await (await callRefresh()).json()).toMatchObject({ error: 'invalid_grant' });
    expect(h.minted).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await callRefresh({ grant_type: 'client_credentials' });
    expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});
