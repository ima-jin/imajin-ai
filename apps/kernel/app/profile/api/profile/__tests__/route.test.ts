/**
 * Tests for the `metadata` jsonb cap on POST /profile/api/profile (#2432).
 * The remaining fields' caps are covered in
 * `[id]/__tests__/tax-registrations.test.ts` and the shared validator's own suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireAuth, mockFindFirst, mockReturning } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockFindFirst: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    query: { profiles: { findFirst: mockFindFirst } },
    insert: () => ({ values: () => ({ returning: mockReturning }) }),
  },
  profiles: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@imajin/config', () => ({
  isValidHandle: () => true,
  HANDLE_ERROR: 'bad handle',
}));

vi.mock('@imajin/logger', () => ({
  withLogger: (
    _service: string,
    handler: (req: unknown, ctx: { log: { error: ReturnType<typeof vi.fn> } }) => Promise<Response>
  ) => (req: unknown) => handler(req, { log: { error: vi.fn() } }),
}));

import { POST } from '../route';
import { PROFILE_JSONB_LIMITS } from '@/src/lib/profile/jsonb-limits';

const DID = 'did:imajin:new-user';

function makeRequest(metadata: unknown): NextRequest {
  return new NextRequest('https://kernel.test/profile/api/profile', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'New User', metadata }),
    headers: { 'content-type': 'application/json' },
  });
}

function metadataWithEntries(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 'v']));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: DID } });
  mockFindFirst.mockResolvedValue(undefined);
  mockReturning.mockResolvedValue([{ did: DID }]);
});

describe('POST /profile/api/profile — metadata size cap (#2432)', () => {
  const { maxEntries, maxStringLength } = PROFILE_JSONB_LIMITS.metadata;

  it('accepts exactly maxEntries metadata keys', async () => {
    const res = await POST(makeRequest(metadataWithEntries(maxEntries)));
    expect(res.status).toBe(201);
  });

  it('rejects maxEntries + 1 keys with a field-named 400 and no insert', async () => {
    const res = await POST(makeRequest(metadataWithEntries(maxEntries + 1)));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.field).toBe('metadata');
    expect(data.error).toContain('metadata');
    expect(mockReturning).not.toHaveBeenCalled();
  });

  it('accepts a string of exactly maxStringLength and rejects one character more', async () => {
    const ok = await POST(makeRequest({ location: 'x'.repeat(maxStringLength) }));
    expect(ok.status).toBe(201);

    const tooLong = await POST(makeRequest({ location: 'x'.repeat(maxStringLength + 1) }));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).field).toBe('metadata');
  });

  it('rejects metadata over maxBytes even when every entry and string is within its cap', async () => {
    const { maxBytes } = PROFILE_JSONB_LIMITS.metadata;
    const chunks = Array.from({ length: Math.ceil(maxBytes / maxStringLength) + 1 }, () => 'x'.repeat(maxStringLength));
    const res = await POST(makeRequest({ chunks }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too large/);
  });

  it('still accepts a request with no metadata', async () => {
    const res = await POST(makeRequest(undefined));
    expect(res.status).toBe(201);
  });
});
