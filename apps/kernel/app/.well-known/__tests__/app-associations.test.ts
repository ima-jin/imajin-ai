import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { operationalRegistryRows } from '@/src/lib/kernel/__tests__/fixtures/third-party-app';

const { where } = vi.hoisted(() => ({ where: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where }) }) },
  registryApps: { id: 'id', slug: 'slug', name: 'name', entryUrl: 'entry_url', status: 'status' },
}));

import { GET as appleGET } from '../apple-app-site-association/route';
import { GET as androidGET } from '../assetlinks.json/route';

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://node.example.test');
  vi.stubEnv('NEXT_PUBLIC_FIXTURE-STUDIO_URL', 'https://override.example.test');
  where.mockResolvedValue(operationalRegistryRows);
});
afterEach(() => vi.unstubAllEnvs());

describe('registry-backed association documents', () => {
  it('fails closed if the registry cannot be read', async () => {
    where.mockRejectedValue(new Error('registry unavailable'));
    await expect(appleGET()).rejects.toThrow('registry unavailable');
    await expect(androidGET()).rejects.toThrow('registry unavailable');
  });
  it('advertises real node and registered external hosts in Apple associations', async () => {
    const response = await appleGET();
    const body = await response.json();
    expect(body.webcredentials.apps).toEqual([]);
    expect(body.applinks.details).toEqual([
      { appID: '*.node.example.test', paths: ['*'], components: [{ '/': '/*', comment: 'node.example.test' }] },
      { appID: '*.studio.example.test', paths: ['*'], components: [{ '/': '/*', comment: 'studio.example.test' }] },
    ]);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('advertises registered origins without synthetic subdomains in Android associations', async () => {
    const response = await androidGET();
    expect(await response.json()).toEqual([
      { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'web', site: 'https://node.example.test' } },
      { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'web', site: 'https://studio.example.test' } },
    ]);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('drops revoked and unsafe destinations from both association documents', async () => {
    where.mockResolvedValue(operationalRegistryRows.filter(row => row.status !== 'active' || row.slug === 'unsafe-app'));
    const apple = await (await appleGET()).json();
    const android = await (await androidGET()).json();
    expect(apple.applinks.details).toHaveLength(1);
    expect(android).toHaveLength(1);
    expect(JSON.stringify({ apple, android })).not.toMatch(/revoked|javascript|unsafe|fixture-studio/);
  });
});
