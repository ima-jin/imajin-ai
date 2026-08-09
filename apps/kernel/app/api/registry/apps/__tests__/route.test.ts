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
  return { mockDbInsertValues, mockDbInsert, mockDbSelect, mockRequireAuth, mockGenerateKeypair };
});

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
