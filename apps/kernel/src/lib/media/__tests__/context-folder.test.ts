import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveContextFolder } from '../context-folder';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), where: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
  registryApps: { slug: 'slug', status: 'status', name: 'name', icon: 'icon' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ column, value }),
  and: (...conditions: unknown[]) => conditions,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.where.mockReturnValue({ limit: mocks.limit });
});

describe('registry app media folders', () => {
  it('uses third-party display metadata without a source-code mapping', async () => {
    mocks.limit.mockResolvedValue([{ name: 'Fixture Studio', icon: '🎨', status: 'active' }]);
    await expect(resolveContextFolder({ app: 'fixture-studio' })).resolves.toEqual({ name: 'Fixture Studio', icon: '🎨' });
    expect(mocks.where).toHaveBeenCalledWith([
      { column: 'slug', value: 'fixture-studio' }, { column: 'status', value: 'active' },
    ]);
  });
  it('provides a neutral icon when a registered app has none', async () => {
    mocks.limit.mockResolvedValue([{ name: 'Studio', icon: null, status: 'active' }]);
    await expect(resolveContextFolder({ app: 'studio' })).resolves.toEqual({ name: 'Studio', icon: '📁' });
  });
  it.each([[], [{ name: 'Revoked', status: 'revoked' }]].map((rows) => ({ rows })))('ignores absent or revoked registrations %j', async ({ rows }) => {
    mocks.limit.mockResolvedValue(rows);
    await expect(resolveContextFolder({ app: 'studio' })).resolves.toBeNull();
  });
  it('keeps kernel feature folders and feature precedence', async () => {
    await expect(resolveContextFolder({ feature: 'voice', app: 'studio' })).resolves.toEqual({ name: 'Audio Recordings', icon: '🎙️' });
    expect(mocks.where).not.toHaveBeenCalled();
  });
  it('does not query for a missing context', async () => {
    await expect(resolveContextFolder({})).resolves.toBeNull();
    expect(mocks.where).not.toHaveBeenCalled();
  });
});
