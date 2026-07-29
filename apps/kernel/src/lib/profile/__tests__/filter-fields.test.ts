import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const mockBroker = vi.fn();
const mockIsBrokerRelease = vi.fn();

vi.mock('@imajin/bus', () => ({
  broker: (...args: unknown[]) => mockBroker(...args),
  isBrokerRelease: (...args: unknown[]) => mockIsBrokerRelease(...args),
}));

const mockLog = { error: vi.fn() };

import { filterProfileFields } from '../index';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBrokerRelease.mockReturnValue(false);
});

describe('filterProfileFields', () => {
  it('returns empty object when metadata is null', async () => {
    const result = await filterProfileFields(null, null, 'did:imajin:viewer', 'did:imajin:owner', mockLog);
    expect(result).toEqual({});
  });

  it('passes through public fields with no rule', async () => {
    const result = await filterProfileFields(
      { bio: 'hello', skills: ['ts'] },
      {},
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(result).toEqual({ bio: 'hello', skills: ['ts'] });
  });

  it('drops private fields', async () => {
    const result = await filterProfileFields(
      { salary: 100000, bio: 'public' },
      { salary: { level: 'private' } },
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(result).toEqual({ bio: 'public' });
    expect(result.salary).toBeUndefined();
  });

  it('passes selective field when viewer is in allowedDids', async () => {
    const result = await filterProfileFields(
      { secret: 'value' },
      { secret: { level: 'selective', allowedDids: ['did:imajin:viewer'] } },
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(result.secret).toBe('value');
  });

  it('drops selective field when viewer is not in allowedDids', async () => {
    const result = await filterProfileFields(
      { secret: 'value' },
      { secret: { level: 'selective', allowedDids: ['did:imajin:someone-else'] } },
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(result.secret).toBeUndefined();
  });

  it('gates connections fields through the broker and includes released data', async () => {
    mockBroker.mockResolvedValueOnce({ type: 'release', data: { location: 'Vancouver' } });
    mockIsBrokerRelease.mockReturnValue(true);

    const result = await filterProfileFields(
      { location: 'Vancouver' },
      { location: { level: 'connections' } },
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(mockBroker).toHaveBeenCalledWith('profile.field.request', expect.objectContaining({
      requester: 'did:imajin:viewer',
      subject: 'did:imajin:owner',
      fields: ['location'],
    }));
    expect(result.location).toBe('Vancouver');
  });

  it('fails closed when broker rejects for connections fields', async () => {
    mockBroker.mockResolvedValueOnce({ type: 'deny' });
    mockIsBrokerRelease.mockReturnValue(false);

    const result = await filterProfileFields(
      { location: 'Vancouver' },
      { location: { level: 'connections' } },
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(result.location).toBeUndefined();
  });

  it('fails closed on broker error and logs', async () => {
    mockBroker.mockRejectedValueOnce(new Error('broker down'));

    const result = await filterProfileFields(
      { location: 'Vancouver' },
      { location: { level: 'connections' } },
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(result.location).toBeUndefined();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('does not call broker when no connections-level fields exist', async () => {
    await filterProfileFields(
      { bio: 'public' },
      { bio: { level: 'public' } },
      'did:imajin:viewer',
      'did:imajin:owner',
      mockLog
    );
    expect(mockBroker).not.toHaveBeenCalled();
  });
});
