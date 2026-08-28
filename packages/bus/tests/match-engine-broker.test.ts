import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { broker } from '../src/broker';
import type { BrokerRequest, BrokerRelease, BrokerRejection } from '../src/types';

// Mock the chain config so the broker uses the availability.match seeded chain
// (mutual-reach-consent → intersection-scope → release → audit)
// instead of falling back to the generic consent → scope default.
const mockGetBrokerChainConfig = vi.fn();
vi.mock('../src/config', async () => {
  const actual = await vi.importActual<typeof import('../src/config')>('../src/config');
  return {
    ...actual,
    getBrokerChainConfig: (...args: Parameters<typeof actual.getBrokerChainConfig>) =>
      mockGetBrokerChainConfig(...args),
  };
});

// Mock publish so audit events don't fire during tests
vi.mock('../src/publish', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

// Mock @imajin/auth so the release reactor's emitAttestation() bridge doesn't
// make real network calls.
vi.mock('@imajin/auth', () => ({
  emitAttestation: vi.fn().mockResolvedValue(undefined),
}));

describe('bus.broker() — availability.match chain (#1872)', () => {
  beforeEach(() => {
    mockGetBrokerChainConfig.mockImplementation(async (eventType: string, scope: string) => {
      if (eventType === 'availability.match') {
        return {
          eventType: 'availability.match',
          scope,
          reactors: [
            { type: 'mutual-reach-consent', config: {}, enabled: true },
            { type: 'intersection-scope', config: {}, enabled: true },
            { type: 'release', config: {}, enabled: true },
            { type: 'audit', config: {}, enabled: true },
          ],
          enabled: true,
        };
      }
      // Fall through to default for other event types
      return null;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeMatchRequest(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
    return {
      type: 'availability.match',
      requester: 'did:imajin:arriver',
      subject: 'did:imajin:candidate',
      fields: ['overlap_tags'],
      purpose: 'availability.match',
      scope: 'calendar',
      data: {
        arriverIntentId: 'intent-arriver-001',
        candidateIntentId: 'intent-candidate-001',
        overlapTags: ['lunch', 'downtown'],
        isSensitive: false,
        deliveryPolicy: 'staged',
        arriverAdmitsCandidate: true,
        candidateAdmitsArriver: true,
      },
      ...overrides,
    };
  }

  function assertRelease(result: unknown): asserts result is BrokerRelease {
    expect(result).toHaveProperty('status', 'released');
  }

  function assertRejection(result: unknown): asserts result is BrokerRejection {
    expect(result).toHaveProperty('status', 'rejected');
  }

  // --------------------------------------------------------------------------
  // End-to-end: previously requester_unauthorized, now succeeds (#1872)
  // --------------------------------------------------------------------------

  it('resolves availability.match with a release when mutual reach is satisfied', async () => {
    const request = makeMatchRequest();
    const result = await broker('availability.match', request);

    assertRelease(result);
    expect(result.data).toEqual({
      overlap_tags: ['lunch', 'downtown'],
      is_sensitive: false,
      delivery_policy: 'staged',
      arriver_intent_id: 'intent-arriver-001',
      candidate_intent_id: 'intent-candidate-001',
    });
    expect(result.envelope).toBeDefined();
    expect(result.envelope.consentReference).toMatch(/^mutual-reach:/);
  });

  it('rejects when arriver does not admit candidate', async () => {
    const request = makeMatchRequest({
      data: {
        arriverIntentId: 'intent-arriver-001',
        candidateIntentId: 'intent-candidate-001',
        overlapTags: ['lunch', 'downtown'],
        isSensitive: false,
        deliveryPolicy: 'staged',
        arriverAdmitsCandidate: false,
        candidateAdmitsArriver: true,
      },
    });
    const result = await broker('availability.match', request);

    assertRejection(result);
    expect(result.reason).toBe('no_consent');
  });

  it('rejects when candidate does not admit arriver', async () => {
    const request = makeMatchRequest({
      data: {
        arriverIntentId: 'intent-arriver-001',
        candidateIntentId: 'intent-candidate-001',
        overlapTags: ['lunch', 'downtown'],
        isSensitive: false,
        deliveryPolicy: 'staged',
        arriverAdmitsCandidate: true,
        candidateAdmitsArriver: false,
      },
    });
    const result = await broker('availability.match', request);

    assertRejection(result);
    expect(result.reason).toBe('no_consent');
  });

  it('rejects when there are no overlapping tags', async () => {
    const request = makeMatchRequest({
      data: {
        arriverIntentId: 'intent-arriver-001',
        candidateIntentId: 'intent-candidate-001',
        overlapTags: [],
        isSensitive: false,
        deliveryPolicy: 'staged',
        arriverAdmitsCandidate: true,
        candidateAdmitsArriver: true,
      },
    });
    const result = await broker('availability.match', request);

    assertRejection(result);
    expect(result.reason).toBe('no_consent');
  });
});
