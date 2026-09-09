/**
 * `evaluateEligibility()` (#1999) — the shared-package client for the
 * kernel's `POST /api/eligibility/evaluate` endpoint. Mirrors
 * emit-attestation.test.ts's approach: fake the kernel's own auth check via
 * a stubbed global fetch, rather than mocking fetch generically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AUTH_SERVICE_URL,
  INTERNAL_API_KEY as API_KEY,
  requestBody,
  setUpInternalPostEnv,
  tearDownInternalPostEnv,
} from './support/internal-post-test-env';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const DID = 'did:imajin:attendee';

beforeEach(setUpInternalPostEnv);
afterEach(tearDownInternalPostEnv);

describe('evaluateEligibility', () => {
  it('POSTs { did } with a Bearer ATTESTATION_INTERNAL_API_KEY and returns the parsed result', async () => {
    const { evaluateEligibility } = await import('../src/evaluate-eligibility');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ did: DID, tier: 'established', upgraded: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateEligibility(DID);

    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/api/eligibility/evaluate`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      }),
    );
    expect(requestBody(fetchMock)).toEqual({ did: DID });
    expect(result).toEqual({ did: DID, tier: 'established', upgraded: true });
  });

  it('returns null and warns without throwing when the kernel rejects the call', async () => {
    const { evaluateEligibility } = await import('../src/evaluate-eligibility');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateEligibility(DID);

    expect(result).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ did: DID, status: 401 }),
      expect.any(String),
    );
  });

  it('returns null and logs an error when fetch itself throws', async () => {
    const { evaluateEligibility } = await import('../src/evaluate-eligibility');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const result = await evaluateEligibility(DID);

    expect(result).toBeNull();
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('returns null without calling fetch when AUTH_SERVICE_URL is unset', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const { evaluateEligibility } = await import('../src/evaluate-eligibility');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateEligibility(DID);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when no internal API key is configured', async () => {
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
    const { evaluateEligibility } = await import('../src/evaluate-eligibility');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluateEligibility(DID);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
