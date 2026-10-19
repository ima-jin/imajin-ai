import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), fetch: vi.fn() }));
vi.mock('@/src/lib/moonshot/connector', () => ({
  MOONSHOT_BASE_URL: 'https://api.moonshot.ai/v1',
  listBillingGrantOwners: mocks.list,
  loadMoonshotBillingCredentials: mocks.load,
}));
vi.mock('../moonshot', () => ({ createMoonshotBalanceReader: () => ({ fetch: mocks.fetch }) }));
import { readMoonshotBillingBalances } from '../moonshot-job';

describe('Moonshot billing balance sweep', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns observations without writing billed spend and skips unsealed keys', async () => {
    mocks.list.mockResolvedValue(['did:a', 'did:b']);
    mocks.load.mockResolvedValueOnce({ apiKey: 'mock-key' }).mockResolvedValueOnce(undefined);
    mocks.fetch.mockResolvedValue({ currency: 'USD', available: 10, cash: 10, voucher: 0 });
    expect(await readMoonshotBillingBalances()).toEqual([{
      ownerDid: 'did:a', billedMode: 'manual-only', balance: { currency: 'USD', available: 10, cash: 10, voucher: 0 },
    }]);
    expect(mocks.load).toHaveBeenCalledWith('did:b');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses regional/non-USD or arbitrary configured endpoints', async () => {
    mocks.list.mockResolvedValue(['did:a']);
    mocks.load.mockResolvedValue({ apiKey: 'mock-key', baseUrl: 'https://api.moonshot.cn/v1' });
    expect(await readMoonshotBillingBalances()).toEqual([{
      ownerDid: 'did:a', billedMode: 'manual-only', error: 'balance_unavailable',
    }]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('supports the canonical endpoint with trailing slash', async () => {
    mocks.list.mockResolvedValue(['did:a']);
    mocks.load.mockResolvedValue({ apiKey: 'mock-key', baseUrl: 'https://api.moonshot.ai/v1/' });
    mocks.fetch.mockResolvedValue({ currency: 'USD', available: 0, cash: 0, voucher: 0 });
    expect((await readMoonshotBillingBalances())[0].balance?.available).toBe(0);
  });

  it('isolates failed reads and never forwards credential/provider errors', async () => {
    mocks.list.mockResolvedValue(['did:a', 'did:b']);
    mocks.load.mockRejectedValueOnce(new Error('mock-key')).mockResolvedValueOnce({ apiKey: 'mock-key' });
    mocks.fetch.mockRejectedValue(new Error('mock-key'));
    const result = await readMoonshotBillingBalances();
    expect(result).toHaveLength(2);
    expect(result.every((row) => row.error === 'balance_unavailable')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('mock-key');
  });

  it('sanitizes enumeration errors', async () => {
    mocks.list.mockRejectedValue(new Error('mock-key'));
    await expect(readMoonshotBillingBalances()).rejects.toThrow('Moonshot billing owners unavailable');
  });
});
