/**
 * Tests for apps/kernel/app/api/registry/apps/route.ts (#1739)
 *
 * Developer app registration must write ONLY to registry.apps. It must never
 * create a side-effect row in auth.identities — that used to happen via the
 * `agent_<appId>` sentinel pattern and poisoned token mint PoP (fixed for the
 * authorize-time promotion path in #1735; this test locks down the
 * creation-time path so it never regresses into doing the same thing).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  mockDbInsertValues,
  mockDbInsert,
  mockDbSelect,
  mockRequireAuth,
  mockGenerateKeypair,
  mockValidateAppDeclarations,
} = vi.hoisted(() => {
  const mockDbInsertValues = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([
      {
        id: 'app_testid0000000000',
        appDid: 'did:imajin:generatedDid',
        name: 'Test App',
        publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
      },
    ]),
  }));
  const mockDbInsert = vi.fn((table: string) => ({ values: mockDbInsertValues, __table: table }));
  const mockDbSelect = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockGenerateKeypair = vi.fn(() => ({
    privateKey: 'priv',
    publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
  }));
  const mockValidateAppDeclarations = vi.fn();
  return { mockDbInsertValues, mockDbInsert, mockDbSelect, mockRequireAuth, mockGenerateKeypair, mockValidateAppDeclarations };
});

// #2663: the validator itself is covered by app-declarations.test.ts.
vi.mock('@/src/lib/kernel/app-declarations', () => ({
  validateAppDeclarations: mockValidateAppDeclarations,
  DEPENDS_ON_OPERATOR_ONLY_ERROR: 'dependsOn is operator-only',
}));

// The mocked `@/src/db` module intentionally does NOT export `identities` —
// if the route regressed into importing/inserting it, this test file would
// fail to construct the mock (or the route's own import would throw),
// surfacing the regression immediately rather than silently passing.
vi.mock('@/src/db', () => ({
  db: { insert: mockDbInsert, select: mockDbSelect },
  registryApps: { id: 'registryApps.id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (...args: unknown[]) => ({ desc: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  generateKeypair: mockGenerateKeypair,
  isValidPublicKey: () => true,
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/auth/crypto', () => ({
  didFromPublicKey: () => 'did:imajin:generatedDid',
}));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown) =>
      handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, correlationId: 'test-cor-id' }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/registry/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateAppDeclarations.mockImplementation(async (input: { providesScopes?: string[]; dependsOn?: unknown[]; requestedScopes?: string[] }) => ({
    ok: { providesScopes: input.providesScopes ?? [], dependsOn: input.dependsOn ?? [], requestedScopes: input.requestedScopes ?? [] },
  }));
  mockRequireAuth.mockResolvedValue({ identity: { id: 'did:imajin:developer' } });
  mockGenerateKeypair.mockReturnValue({
    privateKey: 'priv',
    publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
  });
});

describe('POST /api/registry/apps (#1739)', () => {
  it('inserts only into registry.apps — never auth.identities', async () => {
    const res = await POST(
      makeRequest({ name: 'Test App', callbackUrl: 'https://example.com/callback' }) as never,
    );

    expect(res.status).toBe(201);
    // db.insert() must be called exactly once, targeting registryApps.
    expect(mockDbInsert).toHaveBeenCalledOnce();
    expect(mockDbInsert.mock.calls[0][0]).toEqual({ id: 'registryApps.id' });
  });

  it('works while actingAs a business DID, still only touching registry.apps', async () => {
    mockRequireAuth.mockResolvedValue({
      identity: { id: 'did:imajin:developer', actingFor: 'did:imajin:business' },
    });

    const res = await POST(
      makeRequest({ name: 'Test App', callbackUrl: 'https://example.com/callback' }) as never,
    );

    expect(res.status).toBe(201);
    expect(mockDbInsert).toHaveBeenCalledOnce();
    const insertedRow = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.ownerDid).toBe('did:imajin:business');
    expect(insertedRow.publicKey).not.toMatch(/^agent_/);
  });
});

describe('POST /api/registry/apps — registry fields (#1990)', () => {
  it('always registers as tier: third_party, regardless of request body', async () => {
    const res = await POST(
      makeRequest({ name: 'Test App', callbackUrl: 'https://example.com/callback', tier: 'first_party' }) as never,
    );

    expect(res.status).toBe(201);
    const insertedRow = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.tier).toBe('third_party');
  });

  it('derives allowedRedirectHosts from the callbackUrl origin', async () => {
    const res = await POST(
      makeRequest({ name: 'Test App', callbackUrl: 'https://example.com/callback/path' }) as never,
    );

    expect(res.status).toBe(201);
    const insertedRow = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.allowedRedirectHosts).toEqual(['https://example.com']);
  });

  it('rejects a non-absolute callbackUrl', async () => {
    const res = await POST(makeRequest({ name: 'Test App', callbackUrl: 'not-a-url' }) as never);

    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/registry/apps — #2663 providesScopes', () => {
  it("stores the app's own scopes, and they survive in requestedScopes", async () => {
    mockValidateAppDeclarations.mockResolvedValue({
      ok: { providesScopes: ['dykil:read', 'dykil:write'], dependsOn: [], requestedScopes: ['dykil:read', 'dykil:write'] },
    });

    const res = await POST(
      makeRequest({
        name: 'Dykil',
        callbackUrl: 'https://dykil.example.com/callback',
        requestedScopes: ['dykil:read', 'dykil:write'],
        providesScopes: ['dykil:read', 'dykil:write'],
      }) as never,
    );

    expect(res.status).toBe(201);
    const insertedRow = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.requestedScopes).toEqual(['dykil:read', 'dykil:write']);
    expect(insertedRow.providesScopes).toEqual(['dykil:read', 'dykil:write']);
  });

  it('never writes dependsOn: the row is left to its empty default', async () => {
    const res = await POST(makeRequest({ name: 'Test App', callbackUrl: 'https://example.com/callback' }) as never);

    expect(res.status).toBe(201);
    const insertedRow = mockDbInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedRow.providesScopes).toEqual([]);
    expect(insertedRow).not.toHaveProperty('dependsOn');
  });

  it('rejects with 400 and inserts nothing when providesScopes is invalid', async () => {
    mockValidateAppDeclarations.mockResolvedValue({ error: 'providesScopes rejected: media:write' });

    const res = await POST(
      makeRequest({ name: 'Test App', callbackUrl: 'https://example.com/callback', providesScopes: ['media:write'] }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('media:write');
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/registry/apps — dependsOn is operator-only (#2663)', () => {
  it.each([
    ['a kernel-media dependency', [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }]],
    ['an empty list', []],
    ['a malformed value', 'jin.imajin.ai'],
  ])('rejects %s with 400, before anything is validated or inserted', async (_label, dependsOn) => {
    const res = await POST(
      makeRequest({ name: 'Test App', callbackUrl: 'https://example.com/callback', dependsOn }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('dependsOn is operator-only');
    expect(mockValidateAppDeclarations).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('rejects dependsOn even alongside otherwise valid fields', async () => {
    const res = await POST(
      makeRequest({
        name: 'Dykil',
        callbackUrl: 'https://dykil.example.com/callback',
        providesScopes: ['dykil:read'],
        dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }],
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('still authenticates first: an unauthenticated caller gets 401, not the dependsOn error', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'nope', status: 401 });

    const res = await POST(
      makeRequest({ name: 'X', callbackUrl: 'https://example.com/cb', dependsOn: [] }) as never,
    );

    expect(res.status).toBe(401);
  });
});

describe('POST /api/registry/apps — emittableEvents is operator-only (#2638/#2641)', () => {
  it.each([
    ['a market event list', ['listing.purchased']],
    ['an empty list', []],
    ['a malformed value', 'tip.granted'],
  ])('rejects %s with 400, before anything is validated or inserted', async (_label, emittableEvents) => {
    const res = await POST(
      makeRequest({ name: 'Coffee', callbackUrl: 'https://coffee.example.com/callback', emittableEvents }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('emittableEvents can only be set by a node operator');
    expect(mockValidateAppDeclarations).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('never writes emittableEvents on a normal registration: the row keeps its empty default', async () => {
    const res = await POST(
      makeRequest({ name: 'Coffee', callbackUrl: 'https://coffee.example.com/callback' }) as never,
    );

    expect(res.status).toBe(201);
    expect((mockDbInsertValues.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('emittableEvents');
  });
});
