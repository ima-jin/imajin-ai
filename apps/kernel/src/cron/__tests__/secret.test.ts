import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetInternalSecret, mockError } = vi.hoisted(() => ({
  mockGetInternalSecret: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('../../lib/vault/internal-secret', () => ({
  getInternalSecret: mockGetInternalSecret,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mockError }),
}));

import { resolveCronSecret, _resetCronSecretForTests } from '../secret';
import { CRON_SECRET_PURPOSE } from '../secret-purpose';

describe('resolveCronSecret (vault-held, #2241)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCronSecretForTests();
  });

  it('resolves the secret from the vault by its purpose', async () => {
    mockGetInternalSecret.mockResolvedValue('vault-secret');
    await expect(resolveCronSecret()).resolves.toBe('vault-secret');
    expect(mockGetInternalSecret).toHaveBeenCalledWith(CRON_SECRET_PURPOSE);
    expect(CRON_SECRET_PURPOSE).toBe('kernel.cron-secret');
  });

  it('ignores process.env.CRON_SECRET', async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'hand-pasted';
    try {
      mockGetInternalSecret.mockResolvedValue('vault-secret');
      await expect(resolveCronSecret()).resolves.toBe('vault-secret');
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = original;
    }
  });

  it('returns null (fail closed) and logs an error when the vault read fails', async () => {
    mockGetInternalSecret.mockRejectedValue(new Error('vault unavailable'));
    await expect(resolveCronSecret()).resolves.toBeNull();
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('returns null for an empty secret', async () => {
    mockGetInternalSecret.mockResolvedValue('');
    await expect(resolveCronSecret()).resolves.toBeNull();
  });
});
