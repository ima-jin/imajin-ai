import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureStudio, operationalRegistryRows } from './fixtures/third-party-app';

const { where } = vi.hoisted(() => ({ where: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where }) }) },
  registryApps: { id: 'id', slug: 'slug', name: 'name', entryUrl: 'entry_url', status: 'status' },
}));

import { listOperationalApps, operationalAppOrigins } from '../operational-apps';

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://node.example.test');
  vi.stubEnv('NEXT_PUBLIC_FIXTURE-STUDIO_URL', 'https://override.example.test');
  where.mockResolvedValue(operationalRegistryRows);
});
afterEach(() => vi.unstubAllEnvs());

describe('operational registry inventory', () => {
  it('includes active apps without placements and resolves only registered URLs', async () => {
    const apps = await listOperationalApps();
    expect(apps.filter(app => app.kind === 'app')).toEqual([
      { name: 'fixture-studio', label: 'Fixture Studio', url: 'https://studio.example.test/', kind: 'app' },
      { name: 'relative-app', label: 'Fixture Studio', url: 'https://node.example.test/relative-app', kind: 'app' },
    ]);
    expect(apps.some(app => ['events', 'input', 'learn', 'market'].includes(app.name))).toBe(false);
    expect(apps.filter(app => app.kind === 'core').every(app => app.url.startsWith('https://node.example.test/'))).toBe(true);
    expect(where).toHaveBeenCalled();
  });

  it('uses the registry id when a valid app has no slug', async () => {
    where.mockResolvedValue([{ ...fixtureStudio, slug: null }]);
    expect((await listOperationalApps()).find(app => app.kind === 'app')?.name).toBe(fixtureStudio.id);
  });

  it('deduplicates the kernel origin, relative entries and shared external hosts', async () => {
    where.mockResolvedValue([...operationalRegistryRows, { ...fixtureStudio, id: 'other', entryUrl: 'https://studio.example.test/other' }]);
    expect(await operationalAppOrigins()).toEqual(['https://node.example.test', 'https://studio.example.test']);
  });

  it('returns only kernel routes for an empty registry', async () => {
    where.mockResolvedValue([]);
    expect((await listOperationalApps()).every(app => app.kind === 'core')).toBe(true);
  });

  it('does not silently advertise an incomplete inventory on registry failure', async () => {
    where.mockRejectedValue(new Error('registry unavailable'));
    await expect(listOperationalApps()).rejects.toThrow('registry unavailable');
  });
});
