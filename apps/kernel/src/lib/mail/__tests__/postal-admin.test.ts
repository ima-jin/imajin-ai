import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ vault: vi.fn() }));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: state.vault }));
import { requestPostalDomain, POSTAL_ADMIN_TOKEN_FIELD } from '../postal-admin';
import { postalFixture } from './postal-fixture';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('POSTAL_ADMIN_URL', 'https://postal.example');
  vi.stubEnv('POSTAL_ORGANIZATION', 'node-org');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Postal admin HTTP contract', () => {
  it('uses the node vault on every request, sends exact create body, handles 201/200 and check/read routes', async () => {
    const credential = randomUUID();
    state.vault.mockResolvedValue(credential);
    let exists = false;
    const http = vi.fn(async (input: URL, init: RequestInit) => {
      const url = new URL(input);
      expect(new Headers(init.headers).get('Authorization') === `Bearer ${credential}`).toBe(true);
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname === '/imajin/v1/domains') {
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ organization: 'node-org', name: 'example.org' });
        const status = exists ? 200 : 201;
        exists = true;
        return Response.json(postalFixture(), { status });
      }
      expect(url.searchParams.get('organization')).toBe('node-org');
      expect(url.pathname).toMatch(/^\/imajin\/v1\/domains\/example\.org(?:\/check)?$/);
      expect(init.body).toBeUndefined();
      return Response.json(postalFixture(init.method === 'POST'));
    });
    vi.stubGlobal('fetch', http);
    expect(await requestPostalDomain('example.org', 'create')).toEqual(postalFixture());
    expect(await requestPostalDomain('example.org', 'create')).toEqual(postalFixture());
    expect(await requestPostalDomain('example.org', 'check')).toEqual(postalFixture(true));
    expect(await requestPostalDomain('example.org', 'read')).toEqual(postalFixture());
    expect(state.vault.mock.calls).toEqual(Array.from({ length: 4 }, () => [POSTAL_ADMIN_TOKEN_FIELD]));
  });

  it.each([401, 404, 409, 422, 503])('sanitizes non-2xx %i without reading provider diagnostics', async status => {
    state.vault.mockResolvedValue(randomUUID());
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json }));
    await expect(requestPostalDomain('example.org', 'create')).rejects.toMatchObject({
      code: status === 401 ? 'postal_unauthorized' : 'postal_unavailable', status: 503,
    });
    expect(json).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'invalid whitespace'])('fails closed for unusable vault result %s, ignoring the environment', async value => {
    state.vault.mockResolvedValue(value);
    vi.stubEnv('POSTAL_ADMIN_TOKEN', randomUUID());
    const http = vi.fn();
    vi.stubGlobal('fetch', http);
    await expect(requestPostalDomain('example.org', 'create')).rejects.toMatchObject({ code: 'postal_credential_unavailable' });
    expect(http).not.toHaveBeenCalled();
  });

  it('sanitizes vault integrity failures and network/timeout/parser failures', async () => {
    state.vault.mockRejectedValueOnce(new Error('private diagnostic'));
    await expect(requestPostalDomain('example.org', 'create')).rejects.toMatchObject({ message: 'postal_credential_unavailable' });
    state.vault.mockResolvedValue(randomUUID());
    for (const failure of [new Error('private network diagnostic'), new DOMException('timeout', 'TimeoutError')]) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
      await expect(requestPostalDomain('example.org', 'check')).rejects.toMatchObject({ message: 'postal_unavailable' });
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('private parse diagnostic'); } }));
    await expect(requestPostalDomain('example.org', 'check')).rejects.toMatchObject({ message: 'postal_unavailable' });
  });

  it.each([
    { name: 'other.org' }, { organization: 'other-org' }, { state: 'verified' },
    { records: [] }, { dns_ok: 'true' }, { dns_checked_at: 'invalid' },
    { records: postalFixture().records.filter(record => record.kind !== 'ownership') },
    { records: postalFixture().records.map(record => record.kind === 'spf' ? { ...record, include: undefined } : record) },
  ])('rejects invalid or cross-organization response %j', async override => {
    state.vault.mockResolvedValue(randomUUID());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...postalFixture(), ...override })));
    await expect(requestPostalDomain('example.org', 'create')).rejects.toMatchObject({ code: 'postal_invalid_response' });
  });

  it.each(['', 'http://postal.example', 'https://user:pass@postal.example', 'https://postal.example/path', 'https://postal.example?x=1', 'https://postal.example#fragment'])('rejects unsafe admin URL %s', async url => {
    vi.stubEnv('POSTAL_ADMIN_URL', url);
    await expect(requestPostalDomain('example.org', 'create')).rejects.toMatchObject({ code: 'postal_not_configured' });
    expect(state.vault).not.toHaveBeenCalled();
  });
  it.each(['', 'Uppercase', 'with space', '-leading', 'x'.repeat(256)])('rejects invalid organization permalink %s', async organization => {
    vi.stubEnv('POSTAL_ORGANIZATION', organization);
    await expect(requestPostalDomain('example.org', 'create')).rejects.toMatchObject({ code: 'postal_not_configured' });
  });
});
