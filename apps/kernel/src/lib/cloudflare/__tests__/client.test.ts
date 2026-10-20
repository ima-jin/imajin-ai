import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CloudflareClient } from '../client';
import { bulkSchema, cacheSetSchema, dnsCreateSchema, idSchema } from '../schemas';

const zoneId = 'a'.repeat(32);
const secret = 'synthetic-cloudflare-test-bearer';
const response = (result: unknown, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }));
afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare fixed-origin boundary', () => {
  it('uses only the fixed origin, refuses redirects and projects output', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ id: zoneId, name: 'example.com', secretMetadata: 'ignored' }));
    vi.stubGlobal('fetch', fetch);
    const client = new CloudflareClient(secret, zoneId);
    const result = await client.request('', z.object({ id: idSchema, name: z.string() }).strip());
    expect(result).toEqual({ id: zoneId, name: 'example.com' });
    expect(fetch).toHaveBeenCalledWith(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, expect.objectContaining({
      redirect: 'error', cache: 'no-store', headers: expect.objectContaining({ Authorization: `Bearer ${secret}` }),
    }));
    expect(JSON.stringify(client)).not.toContain(secret);
    await expect(client.request('https://evil.test/', z.unknown())).rejects.toMatchObject({ status: 400 });
    await expect(client.request('/../other', z.unknown())).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    new Response(JSON.stringify({ success: false, errors: [{ message: secret }] }), { status: 403 }),
    response({ name: secret }),
    new Response(`{"success":true,"result":{"name":"${secret.replace('s', '\\u0073')}"}}`),
    new Response('not-json'),
    new Response('x', { headers: { 'Content-Length': '2000001' } }),
  ])('never exposes provider errors or reflected credentials', async provider => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(provider));
    await expect(new CloudflareClient(secret, zoneId).request('', z.unknown()))
      .rejects.toMatchObject({ status: 502, message: 'cloudflare_unavailable' });
  });

  it('sanitizes thrown fetch errors and invalid projected output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(secret)));
    await expect(new CloudflareClient(secret, zoneId).request('', z.string())).rejects.not.toThrow(secret);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ arbitrary: true })));
    await expect(new CloudflareClient(secret, zoneId).request('', z.string())).rejects.toMatchObject({ status: 502 });
  });

  it('bounds pagination and refuses truncated lists', async () => {
    const fetch = vi.fn().mockImplementation(async () => response([1], { result_info: { total_pages: 2 } }));
    vi.stubGlobal('fetch', fetch);
    expect(await new CloudflareClient(secret, zoneId).list('/dns_records', z.number())).toEqual([1, 1]);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () => response([], { result_info: { total_pages: 11 } }));
    await expect(new CloudflareClient(secret, zoneId).list('/dns_records', z.number())).rejects.toMatchObject({ status: 502 });
    fetch.mockImplementation(async () => response(Array.from({ length: 100 }, () => 1)));
    await expect(new CloudflareClient(secret, zoneId).list('/dns_records', z.number())).rejects.toMatchObject({ status: 502 });
  });

  it('strictly rejects arbitrary DNS, cache and bulk fields', () => {
    expect(dnsCreateSchema.safeParse({ type: 'A', name: 'example.com', content: '192.0.2.1', ttl: 1, url: 'evil' }).success).toBe(false);
    expect(bulkSchema.safeParse({ domain: 'example.com', changes: [
      { recordId: zoneId, proxied: true }, { recordId: zoneId, proxied: false },
    ], dryRun: true }).success).toBe(false);
    expect(cacheSetSchema.safeParse({ domain: 'example.com', dryRun: true, rules: [{
      action: 'execute', expression: 'true', enabled: true, action_parameters: {},
    }] }).success).toBe(false);
  });

  it('handles an absent cache ruleset only for that exact GET endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('not exposed', { status: 404 })));
    const client = new CloudflareClient(secret, zoneId);
    expect(await client.request('/rulesets/phases/http_request_cache_settings/entrypoint', z.null(), 'GET', undefined, true)).toBeNull();
    await expect(client.request('/dns_records', z.null(), 'GET', undefined, true)).rejects.toMatchObject({ status: 502 });
  });
});
