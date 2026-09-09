/**
 * `packages/auth/src/credentials.ts` (#1834, #1858, #1998, #1992).
 *
 * Two directions live here:
 *
 *  - **Reverse (email -> DID)**: `getDidForEmail` (credentials-only) and
 *    `resolveDidForEmail` (3-tier precedence) call the kernel's internal
 *    `POST /auth/api/credentials/resolve` (#1992) via the shared
 *    `postInternal()` transport (#2058) — the last direct DB reach in
 *    `@imajin/auth` moved behind this route.
 *  - **Forward (DID -> display name/email)**: `resolveEmailForDid` and
 *    `resolveIdentitiesForDids` call the profile service's batched
 *    `POST /api/resolve` route (#1998). `getEmailForDid` also now calls
 *    `/auth/api/credentials/resolve` (#1992) — it is a narrower
 *    "credentials-only, no fallback" lookup with its own contract, which
 *    the batched route (always 3-tier) does not serve.
 *
 * `postInternal()`-based functions follow evaluate-eligibility.test.ts /
 * backfill-contact-email.test.ts's convention: the shared
 * `support/internal-post-test-env` fixtures, and a dynamic `import()` per
 * test since `setUpInternalPostEnv()` resets the module registry.
 * `resolveIdentitiesForDids`/`resolveEmailForDid` are unaffected by that
 * transport and keep the original static import + `vi.stubEnv` approach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AUTH_SERVICE_URL,
  INTERNAL_API_KEY as API_KEY,
  requestBody,
  setUpInternalPostEnv,
  tearDownInternalPostEnv,
} from './support/internal-post-test-env';

import { resolveEmailForDid, resolveIdentitiesForDids } from '../src/credentials';

const DID = 'did:imajin:kia';
const DID_B = 'did:imajin:jin';

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('getEmailForDid — credentials-only lookup via kernel (#1992)', () => {
  beforeEach(setUpInternalPostEnv);
  afterEach(tearDownInternalPostEnv);

  it('POSTs { did } and returns the resolved email', async () => {
    const { getEmailForDid } = await import('../src/credentials');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ email: 'kia@example.com' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEmailForDid(DID);

    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/api/credentials/resolve`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      }),
    );
    expect(requestBody(fetchMock)).toEqual({ did: DID });
    expect(result).toBe('kia@example.com');
  });

  it('returns null when the kernel reports no email on file', async () => {
    const { getEmailForDid } = await import('../src/credentials');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: null }), { status: 200 })));

    expect(await getEmailForDid(DID)).toBeNull();
  });

  it('returns null when the kernel rejects the call', async () => {
    const { getEmailForDid } = await import('../src/credentials');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })));

    expect(await getEmailForDid(DID)).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const { getEmailForDid } = await import('../src/credentials');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    expect(await getEmailForDid(DID)).toBeNull();
  });

  it('returns null without calling fetch when AUTH_SERVICE_URL is unset', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const { getEmailForDid } = await import('../src/credentials');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await getEmailForDid(DID)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getDidForEmail — credentials-only reverse lookup via kernel (#1992)', () => {
  beforeEach(setUpInternalPostEnv);
  afterEach(tearDownInternalPostEnv);

  it('normalizes the email and POSTs { email, mode: "credential" }', async () => {
    const { getDidForEmail } = await import('../src/credentials');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ did: DID }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getDidForEmail('  Kia@Example.COM  ');

    expect(requestBody(fetchMock)).toEqual({ email: 'kia@example.com', mode: 'credential' });
    expect(result).toBe(DID);
  });

  it('returns null when the kernel reports no match', async () => {
    const { getDidForEmail } = await import('../src/credentials');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ did: null }), { status: 200 })));

    expect(await getDidForEmail('nobody@example.com')).toBeNull();
  });
});

describe('resolveDidForEmail — 3-tier precedence via kernel (#1858, migrated #1992)', () => {
  beforeEach(setUpInternalPostEnv);
  afterEach(tearDownInternalPostEnv);

  it('normalizes the email and POSTs { email, mode: "full" }', async () => {
    const { resolveDidForEmail } = await import('../src/credentials');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ did: DID }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveDidForEmail('  Kia@Example.COM  ');

    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/api/credentials/resolve`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      }),
    );
    expect(requestBody(fetchMock)).toEqual({ email: 'kia@example.com', mode: 'full' });
    expect(result).toBe(DID);
  });

  it('returns null when the email is not known to any of the three sources', async () => {
    const { resolveDidForEmail } = await import('../src/credentials');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ did: null }), { status: 200 })));

    expect(await resolveDidForEmail('nobody@example.com')).toBeNull();
  });

  it('returns null without calling fetch when no internal API key is configured', async () => {
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
    const { resolveDidForEmail } = await import('../src/credentials');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveDidForEmail('kia@example.com')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
