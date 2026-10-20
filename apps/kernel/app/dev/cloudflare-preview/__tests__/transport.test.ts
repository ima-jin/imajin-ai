import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudflarePreviewTransport, fixtureZoneId, installCloudflarePreview } from '../transport';

afterEach(() => vi.unstubAllEnvs());
const path = (resource: string) => `/cloudflare/api/zones/${fixtureZoneId}/${resource}?domain=example.com`;

describe('Cloudflare fixture transport', () => {
  it('refuses production and test installation', () => {
    for (const value of ['production', 'test']) {
      vi.stubEnv('NODE_ENV', value);
      expect(() => createCloudflarePreviewTransport()).toThrow('Development fixture only');
      expect(() => installCloudflarePreview(vi.fn())).toThrow('Development fixture only');
    }
  });
  it('restores transport and never falls through to real APIs', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const previous = globalThis.fetch;
    const dispose = installCloudflarePreview(vi.fn());
    expect((await fetch('https://real-provider.invalid/')).status).toBe(404);
    expect((await fetch('/auth/api/session')).status).toBe(404);
    dispose();
    expect(globalThis.fetch).toBe(previous);
  });
  it('provides fake group/domain metadata and never retains or echoes import input', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const onProposal = vi.fn();
    const { fetcher } = createCloudflarePreviewTransport(onProposal);
    const metadata = await (await fetcher('/api/vault/import')).json();
    expect(metadata.domains[0].domain).toBe('example.com');
    expect(metadata.owners).toHaveLength(2);
    const response = await fetcher('/api/vault/import', { method: 'POST', body: 'FAKE_INPUT_NEVER_PARSED' });
    expect(await response.text()).not.toContain('FAKE_INPUT_NEVER_PARSED');
    expect(JSON.stringify(onProposal.mock.calls)).not.toContain('FAKE_INPUT_NEVER_PARSED');
  });
  it('supports isolated DNS CRUD and previews without applying bulk or cache plans', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const onProposal = vi.fn();
    const { fetcher } = createCloudflarePreviewTransport(onProposal);
    const request = async (resource: string, method = 'GET', body?: unknown) =>
      (await fetcher(path(resource), { method, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    const first = (await request('dns')).records[0];
    const created = (await request('dns', 'POST', { type: 'A', name: 'test.example.com', content: '192.0.2.12', ttl: 1 })).record;
    await request(`dns/${created.id}`, 'PATCH', { proxied: true });
    expect((await request('dns')).records.at(-1).proxied).toBe(true);
    await request(`dns/${created.id}`, 'DELETE');
    expect((await request('dns')).records).toHaveLength(3);
    const plan = { changes: [{ recordId: first.id, proxied: true }], dryRun: true };
    expect((await request('bulk', 'POST', plan)).approval).toBeUndefined();
    expect((await request('bulk', 'POST', { ...plan, dryRun: false })).approval.proposalId).toBeTruthy();
    expect((await request('dns')).records[0].proxied).toBe(false);
    const rules = (await request('cache-rules')).rules;
    await request('cache-rules', 'PUT', { rules: [], dryRun: true });
    await request('cache-rules', 'PUT', { rules: [], dryRun: false });
    expect((await request('cache-rules')).rules).toEqual(rules);
    expect(onProposal).toHaveBeenCalledTimes(2);
    expect((await request('ssl')).ssl).toBeDefined();
    expect((await request('settings')).settings).toBeDefined();
    expect((await request('history')).history[0].signature).toContain('FIXTURE');
    const createdHost = (await request('custom-hostnames', 'POST', { hostname: 'new.example.net' })).hostname;
    expect((await request(`custom-hostnames/${createdHost.id}`)).hostname.hostname).toBe('new.example.net');
    await request(`custom-hostnames/${createdHost.id}`, 'DELETE');
    expect((await request('custom-hostnames')).hostnames).toHaveLength(1);
    expect((await fetcher(path('unknown'))).status).toBe(404);
  });
});
