import { describe, it, expect, vi } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// Return a DB row whose chain references an unregistered reactor.
vi.mock('@imajin/db', () => ({
  getClient: () => () =>
    Promise.resolve([
      {
        reactors: [
          { type: 'emit', config: {}, enabled: true },
          { type: 'unregistered-reactor', config: {}, enabled: true },
        ],
        enabled: true,
      },
    ]),
}));

vi.mock('../src/registry', () => ({
  getReactor: (type: string) => {
    if (type === 'emit') return vi.fn().mockResolvedValue(undefined);
    return undefined;
  },
}));

vi.mock('../src/broker-registry', () => ({
  registerBrokerReactor: vi.fn(),
  getBrokerReactor: (type: string) => {
    if (type === 'emit') return vi.fn().mockResolvedValue({}) as unknown;
    if (type === 'consent') return vi.fn().mockResolvedValue({}) as unknown;
    return undefined;
  },
}));

import { publish } from '../src/publish';
import { broker } from '../src/broker';

describe('load-time validation (#1872)', () => {
  describe('publish-side', () => {
    it('throws when the resolved chain references an unregistered reactor', async () => {
      await expect(
        publish('test.event', {
          issuer: 'did:imajin:alice',
          subject: 'did:imajin:bob',
          scope: 'test',
          payload: {},
        })
      ).rejects.toThrow(
        /Unknown reactor\(s\) in chain for eventType=test\.event scope=test: unregistered-reactor/
      );
    });
  });

  describe('broker-side', () => {
    it('throws when the resolved chain references an unregistered broker reactor', async () => {
      await expect(
        broker('profile.read', {
          requester: 'did:imajin:bob',
          subject: 'did:imajin:alice',
          fields: ['name'],
          purpose: 'test',
          scope: 'test',
          data: { name: 'Alice' },
        })
      ).rejects.toThrow(
        /Unknown broker reactor\(s\) in chain for eventType=profile\.read scope=test: unregistered-reactor/
      );
    });
  });
});
