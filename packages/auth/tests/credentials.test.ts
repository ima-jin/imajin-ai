/**
 * `packages/auth/src/credentials.ts` (#1834, #1858, #1998).
 *
 * Two directions live here, resolved two different ways since #1998:
 *
 *  - **Reverse (email -> DID)**: `getDidForEmail` (credentials-only) and
 *    `resolveDidForEmail` (3-tier precedence) remain raw SQL against
 *    `auth.credentials` / `profile.profiles` / `auth.identities` — the new
 *    batched profile-service endpoint only resolves the forward direction,
 *    so there is nothing for these to migrate onto.
 *  - **Forward (DID -> display name/email)**: `resolveEmailForDid` and the
 *    new `resolveIdentitiesForDids` now call the profile service's batched
 *    `POST /api/resolve` route (#1998) instead of querying the three tables
 *    directly. `getEmailForDid` deliberately stays raw SQL — it is a
 *    narrower "credentials-only, no fallback" lookup with its own contract,
 *    which the new route (always 3-tier) does not serve.
 *
 * Mocking pattern for the still-raw-SQL functions follows
 * packages/bus/AGENTS.md's convention for testing `getClient()` consumers: a
 * fake tagged-template function that records query text/values and resolves
 * from a per-test result queue. The HTTP-based functions instead stub global
 * `fetch`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fakeSql, sqlCalls, queueResult, resetQueue } = vi.hoisted(() => {
  const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
  const queue: unknown[][] = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join(' ? '), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  return {
    fakeSql,
    sqlCalls,
    queueResult: (rows: unknown[]) => queue.push(rows),
    resetQueue: () => queue.splice(0, queue.length),
  };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import {
  getDidForEmail,
  getEmailForDid,
  resolveDidForEmail,
  resolveEmailForDid,
  resolveIdentitiesForDids,
} from '../src/credentials';

const DID = 'did:imajin:kia';
const DID_B = 'did:imajin:jin';

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  resetQueue();
  vi.unstubAllEnvs();
});

describe('resolveDidForEmail — precedence order (#1858), unchanged raw SQL', () => {
  it('resolves via auth.credentials and never queries profile/identities when it hits', async () => {
    queueResult([{ did: DID }]);

    const result = await resolveDidForEmail('kia@example.com');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain('auth.credentials');
  });

  it('falls back to profile.profiles.contact_email when no credential row matches', async () => {
    queueResult([]); // auth.credentials miss
    queueResult([{ did: DID }]); // profile.profiles hit

    const result = await resolveDidForEmail('kia@example.com');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1].text).toContain('profile.profiles');
  });

  it('falls back to auth.identities.contact_email when neither credential nor profile match', async () => {
    queueResult([]); // auth.credentials miss
    queueResult([]); // profile.profiles miss
    queueResult([{ did: DID }]); // auth.identities hit

    const result = await resolveDidForEmail('kia@example.com');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[2].text).toContain('auth.identities');
  });

  it('returns null when the email is not known to any of the three sources', async () => {
    queueResult([]);
    queueResult([]);
    queueResult([]);

    const result = await resolveDidForEmail('nobody@example.com');

    expect(result).toBeNull();
    expect(sqlCalls).toHaveLength(3);
  });

  it('normalizes (lowercase + trim) the email before every query', async () => {
    queueResult([{ did: DID }]);

    await resolveDidForEmail('  Kia@Example.COM  ');

    expect(sqlCalls[0].values).toContain('kia@example.com');
  });
});

describe('getDidForEmail / getEmailForDid — existing credentials-only lookups unchanged', () => {
  it('getDidForEmail normalizes the email and queries only auth.credentials', async () => {
    queueResult([{ did: DID }]);

    const result = await getDidForEmail('  Kia@Example.COM  ');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain('auth.credentials');
    expect(sqlCalls[0].values).toContain('kia@example.com');
  });

  it('getEmailForDid returns null when the DID has no email credential', async () => {
    queueResult([]);

    const result = await getEmailForDid(DID);

    expect(result).toBeNull();
  });
});

describe('resolveIdentitiesForDids — batched HTTP client for /api/resolve (#1998)', () => {
  beforeEach(() => {
    vi.stubEnv('PROFILE_SERVICE_URL', 'https://kernel.test/profile');
    vi.stubEnv('PROFILE_INTERNAL_API_KEY', 'internal-secret');
  });

  it('returns an empty map without calling fetch when given no DIDs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveIdentitiesForDids([]);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty map when PROFILE_SERVICE_URL is not configured', async () => {
    vi.stubEnv('PROFILE_SERVICE_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveIdentitiesForDids([DID]);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the deduped DID list with the internal-key bearer and builds a did -> entry map', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { did: DID, handle: 'kia', displayName: 'Kia', email: 'kia@example.com' },
          { did: DID_B, handle: 'jin', displayName: 'Jin' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveIdentitiesForDids([DID, DID, DID_B]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://kernel.test/profile/api/resolve',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer internal-secret' }),
        body: JSON.stringify({ dids: [DID, DID_B] }),
      }),
    );
    expect(result.get(DID)).toEqual({ did: DID, handle: 'kia', displayName: 'Kia', email: 'kia@example.com' });
    expect(result.get(DID_B)?.email).toBeUndefined();
  });

  it('fails soft (empty map) on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await resolveIdentitiesForDids([DID]);

    expect(result.size).toBe(0);
  });

  it('fails soft (empty map) when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await resolveIdentitiesForDids([DID]);

    expect(result.size).toBe(0);
  });

  it('chunks requests larger than 200 DIDs into multiple calls', async () => {
    const dids = Array.from({ length: 250 }, (_, i) => `did:imajin:bulk-${i}`);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await resolveIdentitiesForDids(dids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.dids).toHaveLength(200);
    expect(secondBody.dids).toHaveLength(50);
  });
});

describe('resolveEmailForDid — migrated onto /api/resolve (#1998)', () => {
  beforeEach(() => {
    vi.stubEnv('PROFILE_SERVICE_URL', 'https://kernel.test/profile');
    vi.stubEnv('PROFILE_INTERNAL_API_KEY', 'internal-secret');
  });

  it('returns the email the resolve endpoint reports for the DID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ did: DID, handle: null, displayName: null, email: 'kia@example.com' }] }),
    }));

    const result = await resolveEmailForDid(DID);

    expect(result).toBe('kia@example.com');
    // No raw SQL involved anymore for this path.
    expect(sqlCalls).toHaveLength(0);
  });

  it('returns null when the endpoint omits email for this DID (unauthorized or unknown)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ did: DID, handle: 'kia', displayName: 'Kia' }] }),
    }));

    const result = await resolveEmailForDid(DID);

    expect(result).toBeNull();
  });

  it('returns null when the profile service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    const result = await resolveEmailForDid(DID);

    expect(result).toBeNull();
  });
});
