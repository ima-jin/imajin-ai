/**
 * POST /profile/api/resolve — batched DID -> { handle, displayName, email? }
 * resolution (#1998). Covers: batch happy path, unknown DIDs, cap
 * enforcement, and email gating (service-scope vs. self vs. anonymous).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbSelect, mockGetSessionFromCookies, fakeSql, sqlCalls, queueResult, resetQueue } = vi.hoisted(() => {
  const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
  const queue: unknown[][] = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join(' ? '), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  return {
    mockDbSelect: vi.fn(),
    mockGetSessionFromCookies: vi.fn(),
    fakeSql,
    sqlCalls,
    queueResult: (rows: unknown[]) => queue.push(rows),
    resetQueue: () => queue.splice(0, queue.length),
  };
});

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(async () => result);
  return chain;
}

vi.mock('@/src/db', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
  profiles: { did: 'profiles.did', handle: 'profiles.handle', displayName: 'profiles.display_name' },
}));

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

vi.mock('@/src/lib/kernel/session', () => ({
  getSessionFromCookies: mockGetSessionFromCookies,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

const DID_A = 'did:imajin:alice';
const DID_B = 'did:imajin:bob';
const DID_UNKNOWN = 'did:imajin:ghost';
const INTERNAL_KEY = 'service-secret-key';

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  resetQueue();
  mockGetSessionFromCookies.mockResolvedValue(null);
  vi.stubEnv('PROFILE_INTERNAL_API_KEY', INTERNAL_KEY);
});

describe('batch happy path', () => {
  it('resolves handle/displayName for known DIDs with no auth required', async () => {
    mockDbSelect.mockReturnValueOnce(selectChain([
      { did: DID_A, handle: 'alice', displayName: 'Alice' },
      { did: DID_B, handle: 'bob', displayName: 'Bob' },
    ]));

    const res = await POST(makeReq({ dids: [DID_A, DID_B] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.results).toEqual(
      expect.arrayContaining([
        { did: DID_A, handle: 'alice', displayName: 'Alice' },
        { did: DID_B, handle: 'bob', displayName: 'Bob' },
      ]),
    );
    // No email field at all without authorization.
    expect(json.results.every((r: Record<string, unknown>) => !('email' in r))).toBe(true);
  });

  it('de-duplicates repeated DIDs in the request', async () => {
    mockDbSelect.mockReturnValueOnce(selectChain([{ did: DID_A, handle: 'alice', displayName: 'Alice' }]));

    const res = await POST(makeReq({ dids: [DID_A, DID_A, DID_A] }));
    const json = await res.json();

    expect(json.results).toHaveLength(1);
  });

  it('returns an empty result set for an empty dids array without querying the DB', async () => {
    const res = await POST(makeReq({ dids: [] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.results).toEqual([]);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});

describe('unknown DIDs', () => {
  it('silently omits DIDs with no profile row and no visible email', async () => {
    mockDbSelect.mockReturnValueOnce(selectChain([{ did: DID_A, handle: 'alice', displayName: 'Alice' }]));

    const res = await POST(makeReq({ dids: [DID_A, DID_UNKNOWN] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.results).toHaveLength(1);
    expect(json.results[0].did).toBe(DID_A);
  });

  it('rejects a non-array dids field', async () => {
    const res = await POST(makeReq({ dids: 'not-an-array' }));
    expect(res.status).toBe(400);
  });

  it('rejects a dids array containing non-string entries', async () => {
    const res = await POST(makeReq({ dids: [DID_A, 42] }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = {
      headers: new Headers(),
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('cap enforcement', () => {
  it('rejects a batch larger than the max (200)', async () => {
    const dids = Array.from({ length: 201 }, (_, i) => `did:imajin:bulk-${i}`);

    const res = await POST(makeReq({ dids }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('200');
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('accepts a batch exactly at the max (200)', async () => {
    const dids = Array.from({ length: 200 }, (_, i) => `did:imajin:bulk-${i}`);
    mockDbSelect.mockReturnValueOnce(selectChain([]));

    const res = await POST(makeReq({ dids }));

    expect(res.status).toBe(200);
  });
});

describe('email gating', () => {
  it('includes email for every requested DID when the caller presents the service-scope internal key', async () => {
    mockDbSelect.mockReturnValueOnce(selectChain([{ did: DID_A, handle: 'alice', displayName: 'Alice' }]));
    queueResult([{ did: DID_A, value: 'alice@example.com' }]); // auth.credentials hit

    const res = await POST(
      makeReq({ dids: [DID_A] }, { authorization: `Bearer ${INTERNAL_KEY}` }),
    );
    const json = await res.json();

    expect(json.results[0].email).toBe('alice@example.com');
  });

  it('falls back through profile.profiles then auth.identities for service-scope callers', async () => {
    mockDbSelect.mockReturnValueOnce(selectChain([{ did: DID_A, handle: 'alice', displayName: 'Alice' }]));
    queueResult([]); // auth.credentials miss
    queueResult([{ did: DID_A, value: 'alice@profile.example.com' }]); // profile.profiles hit

    const res = await POST(
      makeReq({ dids: [DID_A] }, { authorization: `Bearer ${INTERNAL_KEY}` }),
    );
    const json = await res.json();

    expect(json.results[0].email).toBe('alice@profile.example.com');
    expect(sqlCalls[1].text).toContain('profile.profiles');
  });

  it('rejects a bearer token that does not match the internal key', async () => {
    mockDbSelect.mockReturnValueOnce(selectChain([{ did: DID_A, handle: 'alice', displayName: 'Alice' }]));

    const res = await POST(
      makeReq({ dids: [DID_A] }, { authorization: 'Bearer wrong-key' }),
    );
    const json = await res.json();

    expect(json.results[0].email).toBeUndefined();
  });

  it('gives a session-authenticated caller their own email only', async () => {
    mockGetSessionFromCookies.mockResolvedValue({ did: DID_A });
    mockDbSelect.mockReturnValueOnce(selectChain([
      { did: DID_A, handle: 'alice', displayName: 'Alice' },
      { did: DID_B, handle: 'bob', displayName: 'Bob' },
    ]));
    queueResult([{ did: DID_A, value: 'alice@example.com' }]); // only DID_A's email is fetched

    const res = await POST(makeReq({ dids: [DID_A, DID_B] }, { cookie: 'imajin_session=tok' }));
    const json = await res.json();

    const alice = json.results.find((r: Record<string, unknown>) => r.did === DID_A);
    const bob = json.results.find((r: Record<string, unknown>) => r.did === DID_B);
    expect(alice.email).toBe('alice@example.com');
    expect(bob.email).toBeUndefined();
    // Only the caller's own DID is ever passed to the email-resolution query.
    expect(sqlCalls[0].values).toEqual([[DID_A]]);
  });

  it('never includes email for an anonymous caller', async () => {
    mockDbSelect.mockReturnValueOnce(selectChain([{ did: DID_A, handle: 'alice', displayName: 'Alice' }]));

    const res = await POST(makeReq({ dids: [DID_A] }));
    const json = await res.json();

    expect(json.results[0].email).toBeUndefined();
    expect(sqlCalls).toHaveLength(0);
  });
});
