import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { CloudflareDnsProvider, txtValue } from '../cloudflare';
import type { DnsProvider, DnsRecord } from '../types';

const zoneId = 'a'.repeat(32);
const recordId = 'b'.repeat(32);
const testToken = 'mock-only-provider-credential';
const spf: DnsRecord = { type: 'TXT', name: 'example.com', content: 'v=spf1 include:postal.example.net ~all' };
const dkim: DnsRecord = { type: 'TXT', name: 'dkim._domainkey.example.com', content: 'v=DKIM1; p=public-key' };
const cname: DnsRecord = { type: 'CNAME', name: 'rp.example.com', content: 'postal.example.net' };
type Stored = { id: string; type: string; name: string; content: string; proxied?: boolean };
let stored: Stored[];
let provider: DnsProvider;
const http = vi.fn();

function envelope(result: unknown, pages = 1): Response {
  return Response.json({ success: true, result, result_info: { total_pages: pages } });
}
function mutations() {
  return http.mock.calls.filter(([, init]) => init.method !== 'GET');
}

beforeEach(() => {
  stored = [];
  provider = new CloudflareDnsProvider('example.com', zoneId, testToken);
  http.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith(`/zones/${zoneId}`)) return envelope({ name: 'example.com' });
    if (init.method === 'GET') {
      return envelope(stored.filter((entry) => entry.name === parsed.searchParams.get('name.exact')));
    }
    const body = JSON.parse(String(init.body));
    if (init.method === 'POST') {
      stored.push({ ...body, id: String(stored.length + 1).padStart(32, '0') });
    } else {
      const current = stored.find((entry) => parsed.pathname.endsWith(entry.id))!;
      Object.assign(current, body);
    }
    return envelope({});
  });
  vi.stubGlobal('fetch', http);
});
afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare adapter HTTP contract', () => {
  it('creates proof, DKIM and DNS-only return path once, and is idempotent on retry', async () => {
    const proof: DnsRecord = { type: 'TXT', name: '_imajin.example.com', content: 'did:imajin:owner' };
    const result = await provider.apply([proof, dkim, cname, dkim]);
    expect(result).toMatchObject({ mode: 'automatic', status: 'written', records: [proof, dkim, cname] });
    expect(mutations()).toHaveLength(3);
    expect(stored.find((entry) => entry.type === 'CNAME')).toMatchObject({ proxied: false, ttl: 1 });
    expect(await provider.apply([proof, dkim, cname])).toEqual(result);
    expect(mutations()).toHaveLength(3);
    for (const [url, init] of http.mock.calls) {
      expect(url).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\/zones\//u);
      expect(url).not.toContain(testToken);
      expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${testToken}` } });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(result)).not.toContain(testToken);
    expect(JSON.stringify(provider)).not.toContain(testToken);
    expect(inspect(provider)).not.toContain(testToken);
  });

  it('merges strict SPF without replacing other TXT, TTL, comments or includes', async () => {
    stored = [
      { id: recordId, type: 'TXT', name: 'example.com', content: '"v=spf1 include:spf.protection.outlook.com " "-all"' },
      { id: 'c'.repeat(32), type: 'TXT', name: 'example.com', content: 'mailbox-verification=untouched' },
    ];
    const result = await provider.apply([spf]);
    expect(result.records[0].content)
      .toBe('v=spf1 include:spf.protection.outlook.com include:postal.example.net -all');
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][1]).toMatchObject({
      method: 'PATCH', body: JSON.stringify({ content: result.records[0].content }),
    });
    expect(stored[1].content).toBe('mailbox-verification=untouched');
    await provider.apply([spf]);
    expect(mutations()).toHaveLength(1);
  });

  it('creates a fresh SPF only if none exists', async () => {
    await provider.apply([spf]);
    await provider.apply([spf]);
    expect(mutations()).toHaveLength(1);
    expect(stored[0].content).toBe(spf.content);
  });

  it('unproxies only an otherwise identical existing mail CNAME', async () => {
    stored = [{ ...cname, content: 'POSTAL.EXAMPLE.NET.', id: recordId, proxied: true }];
    await provider.apply([cname]);
    expect(mutations()[0][1]).toMatchObject({
      method: 'PATCH', body: JSON.stringify({ content: cname.content, proxied: false }),
    });
    await provider.apply([cname]);
    expect(mutations()).toHaveLength(1);
  });

  it.each([
    { entries: [{ ...cname, content: 'existing-mailbox.example.net', id: recordId }] },
    { entries: [{ type: 'MX', name: cname.name, content: 'existing-mailbox.example.net', id: recordId }] },
    { entries: [{ ...cname, type: 'NS', id: recordId }] },
  ])('refuses conflicts without touching existing mailbox/routing data (%#)', async ({ entries }) => {
    stored = entries;
    await expect(provider.apply([dkim, cname])).rejects.toMatchObject({ code: 'dns_record_conflict' });
    expect(mutations()).toHaveLength(0);
  });

  it('refuses TXT over CNAME and multiple SPF policies', async () => {
    stored = [{ ...dkim, type: 'CNAME', content: 'existing.example.net', id: recordId }];
    await expect(provider.apply([dkim])).rejects.toMatchObject({ code: 'dns_record_conflict' });
    stored = [{ ...spf, id: recordId }, { ...spf, id: 'c'.repeat(32) }];
    await expect(provider.apply([spf])).rejects.toMatchObject({ code: 'ambiguous_spf' });
    expect(mutations()).toHaveLength(0);
  });

  it('rejects the entire out-of-scope plan before HTTP', async () => {
    await expect(provider.apply([dkim, { ...spf, name: 'another-zone.net' }])).rejects.toThrow('invalid_dns_records');
    expect(http).not.toHaveBeenCalled();
  });

  it('validates the zone and allows a bound subdomain only within its actual zone', async () => {
    http.mockResolvedValueOnce(envelope({ name: 'notexample.com' }));
    await expect(provider.apply([spf])).rejects.toThrow('dns_zone_mismatch');
    const child = new CloudflareDnsProvider('sub.example.com', zoneId, testToken);
    await expect(child.apply([{ ...dkim, name: 'dkim._domainkey.sub.example.com' }])).resolves.toMatchObject({ status: 'written' });
    expect(() => new CloudflareDnsProvider('example.com', '../invalid', testToken)).toThrow('invalid_dns_zone');
  });

  it('reads all pages before deciding a record is missing', async () => {
    http.mockResolvedValueOnce(envelope({ name: 'example.com' }))
      .mockResolvedValueOnce(envelope([], 2))
      .mockResolvedValueOnce(envelope([{ ...dkim, id: recordId }], 2));
    await provider.apply([dkim]);
    expect(String(http.mock.calls[2][0])).toContain('page=2');
    expect(mutations()).toHaveLength(0);
  });

  it('refuses truncated or malformed listings instead of writing blindly', async () => {
    http.mockResolvedValueOnce(envelope({ name: 'example.com' })).mockResolvedValueOnce(Response.json({ success: true, result: [] }));
    await expect(provider.apply([spf])).rejects.toThrow('invalid_dns_provider_response');
    http.mockResolvedValueOnce(envelope({ name: 'example.com' })).mockResolvedValueOnce(envelope([{ ...spf, id: '../escape' }]));
    await expect(provider.apply([spf])).rejects.toThrow('invalid_dns_provider_response');
    http.mockResolvedValueOnce(envelope({ name: 'example.com' })).mockResolvedValueOnce(envelope([{ ...spf, name: 'other.com', id: recordId }]));
    await expect(provider.apply([spf])).rejects.toThrow('invalid_dns_provider_response');
    http.mockResolvedValueOnce(envelope({ name: 'example.com' }));
    for (let page = 1; page <= 10; page++) http.mockResolvedValueOnce(envelope([], 11));
    await expect(provider.apply([spf])).rejects.toThrow('dns_record_limit');
    expect(mutations()).toHaveLength(0);
  });

  it.each(['http', 'api', 'network', 'json'])('redacts %s failure with no cause or provider body', async (kind) => {
    if (kind === 'http') http.mockResolvedValueOnce(new Response(testToken, { status: 403 }));
    if (kind === 'api') http.mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: testToken }] }));
    if (kind === 'network') http.mockRejectedValueOnce(new Error(testToken));
    if (kind === 'json') http.mockResolvedValueOnce(new Response(testToken));
    const error = await provider.apply([spf]).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: 'dns_provider_unavailable' });
    expect(inspect(error)).not.toContain(testToken);
    expect(mutations()).toHaveLength(0);
  });

  it('reports failed writes, and a later operation can recover without duplicating earlier writes', async () => {
    http.mockResolvedValueOnce(envelope({ name: 'example.com' }))
      .mockResolvedValueOnce(envelope([]))
      .mockRejectedValueOnce(new Error('write failed'));
    await expect(provider.apply([dkim])).rejects.toThrow('dns_provider_unavailable');
    await provider.apply([dkim]);
    await provider.apply([dkim]);
    expect(stored).toHaveLength(1);
  });

  it('decodes supported TXT chunks but never guesses unsupported encodings', () => {
    expect(txtValue('"v=spf1 " "include:example.net -all"')).toBe('v=spf1 include:example.net -all');
    expect(txtValue('"escaped\\"quote"')).toBe('escaped"quote');
    expect(txtValue('unquoted')).toBe('unquoted');
    expect(() => txtValue('"broken')).toThrow('unsupported_txt_encoding');
    expect(() => txtValue('"unsupported\\032escape"')).toThrow('unsupported_txt_encoding');
  });
});
