import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAccess = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>());

vi.mock('node:fs/promises', () => ({ access: mockAccess }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

import { getAvailableVariants, getVariantPath } from '../transcode';

describe('getAvailableVariants', () => {
  beforeEach(() => {
    mockAccess.mockReset();
  });

  it('reports each quality independently, keyed by quality', async () => {
    const present = getVariantPath('/media/clip.mov', '720p');
    mockAccess.mockImplementation(async (path) => {
      if (path !== present) throw new Error('ENOENT');
    });

    await expect(getAvailableVariants('/media/clip.mov')).resolves.toEqual({
      '1080p': false,
      '720p': true,
      '360p': false,
    });
    expect(mockAccess).toHaveBeenCalledTimes(3);
  });

  it('reports every quality missing when none exists', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(getAvailableVariants('/media/none.mov')).resolves.toEqual({
      '1080p': false,
      '720p': false,
      '360p': false,
    });
  });
});
