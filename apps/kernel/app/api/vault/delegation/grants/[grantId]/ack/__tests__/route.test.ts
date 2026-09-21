/**
 * Unit tests for POST /api/vault/delegation/grants/{grantId}/ack (#2235,
 * follow-up to #2231's fetch route).
 *
 * Covers: authentication, body validation (outcome/note/evidence), every
 * non-'ok' outcome's HTTP status + error code mapping (404 for
 * not_found/not_grantee, 409 for not_fetched/conflict), idempotent replay,
 * the success response shape, and that every attempt — success or refusal —
 * publishes the vault.delegation.acked audit event with no secret material,
 * `note`, or `evidence.ref` in its payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockAckGrant, mockPublish } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockAckGrant: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/vault', () => ({
  ackGrant: mockAckGrant,
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from '../route.js';

const AGENT = 'did:imajin:gha-runner-agent';
const OWNER = 'did:imajin:chris';
const GRANT_ID = 'vdg_test123';

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/api/vault/delegation/grants/${GRANT_ID}/ack`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function makeRawRequest(rawBody: string): Request {
  return new Request(`http://localhost/api/vault/delegation/grants/${GRANT_ID}/ack`, {
    method: 'POST',
    body: rawBody,
  });
}

function callRoute(request: Request) {
  return POST(request as never, { params: Promise.resolve({ grantId: GRANT_ID }) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: AGENT } });
  mockPublish.mockResolvedValue(undefined);
});

describe('POST /api/vault/delegation/grants/{grantId}/ack — auth', () => {
  it('returns 401 when not authenticated', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
    const response = await callRoute(makeRequest({ outcome: 'used' }));
    expect(response.status).toBe(401);
    expect(mockAckGrant).not.toHaveBeenCalled();
  });

  it('resolves the grantee from the caller identity, not the request body', async () => {
    mockAckGrant.mockResolvedValue({
      status: 'ok', ackedAt: new Date('2025-01-01T00:00:00Z'), ackOutcome: 'used', ownerDid: OWNER, purpose: null,
    });
    await callRoute(makeRequest({ outcome: 'used' }));
    expect(mockAckGrant).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: GRANT_ID, granteeDid: AGENT, outcome: 'used' }),
    );
  });
});

describe('POST /api/vault/delegation/grants/{grantId}/ack — body validation', () => {
  it('returns 400 for malformed JSON', async () => {
    const response = await callRoute(makeRawRequest('{not json'));
    expect(response.status).toBe(400);
    expect(mockAckGrant).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ outcome: 'invalid' }],
    [{ outcome: 123 }],
    [{ outcome: null }],
  ])('rejects a bad outcome: %j', async (body) => {
    const response = await callRoute(makeRequest(body));
    expect(response.status).toBe(400);
    expect(mockAckGrant).not.toHaveBeenCalled();
  });

  it('rejects a note over 280 characters', async () => {
    const response = await callRoute(makeRequest({ outcome: 'used', note: 'x'.repeat(281) }));
    expect(response.status).toBe(400);
    expect(mockAckGrant).not.toHaveBeenCalled();
  });

  it('accepts a note at exactly 280 characters', async () => {
    mockAckGrant.mockResolvedValue({
      status: 'ok', ackedAt: new Date(), ackOutcome: 'used', ownerDid: OWNER, purpose: null,
    });
    const response = await callRoute(makeRequest({ outcome: 'used', note: 'x'.repeat(280) }));
    expect(response.status).toBe(200);
  });

  it('rejects an empty note', async () => {
    const response = await callRoute(makeRequest({ outcome: 'used', note: '' }));
    expect(response.status).toBe(400);
  });

  it('rejects evidence missing ref', async () => {
    const response = await callRoute(makeRequest({ outcome: 'used', evidence: { kind: 'gha-runner' } }));
    expect(response.status).toBe(400);
    expect(mockAckGrant).not.toHaveBeenCalled();
  });

  it('rejects evidence with an oversized ref', async () => {
    const response = await callRoute(
      makeRequest({ outcome: 'used', evidence: { kind: 'gha-runner', ref: 'x'.repeat(121) } }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a non-object evidence', async () => {
    const response = await callRoute(makeRequest({ outcome: 'used', evidence: 'gha-runner' }));
    expect(response.status).toBe(400);
  });

  it('accepts a body with only outcome (note/evidence optional)', async () => {
    mockAckGrant.mockResolvedValue({
      status: 'ok', ackedAt: new Date(), ackOutcome: 'discarded', ownerDid: OWNER, purpose: null,
    });
    const response = await callRoute(makeRequest({ outcome: 'discarded' }));
    expect(response.status).toBe(200);
    expect(mockAckGrant).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'discarded', evidence: null }),
    );
  });
});

describe('POST /api/vault/delegation/grants/{grantId}/ack — outcomes', () => {
  it('returns 200 with ok/grantId/outcome/ackedAt on success', async () => {
    const ackedAt = new Date('2025-01-01T00:00:00Z');
    mockAckGrant.mockResolvedValue({ status: 'ok', ackedAt, ackOutcome: 'used', ownerDid: OWNER, purpose: 'gha-runner-registration' });

    const response = await callRoute(makeRequest({ outcome: 'used', evidence: { kind: 'gha-runner', ref: 'imajin-gx10' } }));
    const body = await response.json() as { ok: boolean; grantId: string; outcome: string; ackedAt: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.grantId).toBe(GRANT_ID);
    expect(body.outcome).toBe('used');
    expect(body.ackedAt).toBe(ackedAt.toISOString());
  });

  it.each([
    ['not_found', 404],
    ['not_grantee', 404],
    ['not_fetched', 409],
  ] as const)('maps %s to HTTP %i', async (status, expectedStatus) => {
    mockAckGrant.mockResolvedValue({ status });
    const response = await callRoute(makeRequest({ outcome: 'used' }));
    expect(response.status).toBe(expectedStatus);
  });

  it('maps not_fetched to the grant_not_fetched error code', async () => {
    mockAckGrant.mockResolvedValue({ status: 'not_fetched' });
    const response = await callRoute(makeRequest({ outcome: 'used' }));
    const body = await response.json() as { error: string };
    expect(response.status).toBe(409);
    expect(body.error).toBe('grant_not_fetched');
  });

  it('maps conflict to 409 ack_conflict, reporting the existing ack', async () => {
    const ackedAt = new Date('2025-01-01T00:00:00Z');
    mockAckGrant.mockResolvedValue({ status: 'conflict', ackedAt, ackOutcome: 'discarded' });

    const response = await callRoute(makeRequest({ outcome: 'used' }));
    const body = await response.json() as { error: string; ackedAt: string; ackOutcome: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe('ack_conflict');
    expect(body.ackOutcome).toBe('discarded');
    expect(body.ackedAt).toBe(ackedAt.toISOString());
  });

  it('is idempotent: acking the SAME outcome twice both return 200 with the same ackedAt', async () => {
    const ackedAt = new Date('2025-01-01T00:00:00Z');
    mockAckGrant.mockResolvedValue({ status: 'ok', ackedAt, ackOutcome: 'used', ownerDid: OWNER, purpose: null });

    const first = await callRoute(makeRequest({ outcome: 'used' }));
    const second = await callRoute(makeRequest({ outcome: 'used' }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json() as { ackedAt: string };
    const secondBody = await second.json() as { ackedAt: string };
    expect(secondBody.ackedAt).toBe(firstBody.ackedAt);
  });

  it('never leaks a secret-shaped value on any outcome', async () => {
    mockAckGrant.mockResolvedValue({ status: 'not_fetched' });
    const response = await callRoute(makeRequest({ outcome: 'used' }));
    const text = await response.text();
    expect(text).not.toContain('value');
  });

  it('returns a vault error response when ackGrant throws', async () => {
    mockAckGrant.mockRejectedValue(new Error('db unavailable'));
    const response = await callRoute(makeRequest({ outcome: 'used' }));
    expect(response.status).toBe(500);
  });
});

describe('POST /api/vault/delegation/grants/{grantId}/ack — audit', () => {
  it('publishes vault.delegation.acked with no refused field on success', async () => {
    const ackedAt = new Date('2025-01-01T00:00:00Z');
    mockAckGrant.mockResolvedValue({
      status: 'ok', ackedAt, ackOutcome: 'used', ownerDid: OWNER, purpose: 'gha-runner-registration',
    });

    await callRoute(makeRequest({ outcome: 'used', note: 'ran the exec', evidence: { kind: 'gha-runner', ref: 'imajin-gx10' } }));

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [eventType, event] = mockPublish.mock.calls[0]!;
    expect(eventType).toBe('vault.delegation.acked');
    expect(event.payload.grantId).toBe(GRANT_ID);
    expect(event.payload.granteeDid).toBe(AGENT);
    expect(event.payload.ownerDid).toBe(OWNER);
    expect(event.payload.outcome).toBe('used');
    expect(event.payload.evidenceKind).toBe('gha-runner');
    expect(event.payload.refused).toBeNull();
  });

  it('never includes the free-text note or evidence.ref in the audit payload', async () => {
    mockAckGrant.mockResolvedValue({
      status: 'ok', ackedAt: new Date(), ackOutcome: 'used', ownerDid: OWNER, purpose: null,
    });

    await callRoute(makeRequest({
      outcome: 'used',
      note: 'super secret token value abc123',
      evidence: { kind: 'gha-runner', ref: 'imajin-gx10-secret-ref' },
    }));

    const [, event] = mockPublish.mock.calls[0]!;
    const serialized = JSON.stringify(event.payload);
    expect(serialized).not.toContain('super secret token value abc123');
    expect(serialized).not.toContain('imajin-gx10-secret-ref');
  });

  it('publishes an audit event with a refused code for a refusal', async () => {
    mockAckGrant.mockResolvedValue({ status: 'not_fetched' });
    await callRoute(makeRequest({ outcome: 'used' }));

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, event] = mockPublish.mock.calls[0]!;
    expect(event.payload.refused).toBe('not_fetched');
    expect(event.payload.outcome).toBe('used');
  });

  it('maps the internal conflict status to the ack_conflict refused code in the audit event', async () => {
    mockAckGrant.mockResolvedValue({ status: 'conflict', ackedAt: new Date(), ackOutcome: 'discarded' });
    await callRoute(makeRequest({ outcome: 'used' }));

    const [, event] = mockPublish.mock.calls[0]!;
    expect(event.payload.refused).toBe('ack_conflict');
  });

  it('publishes an error outcome when ackGrant throws', async () => {
    mockAckGrant.mockRejectedValue(new Error('db unavailable'));
    await callRoute(makeRequest({ outcome: 'failed' }));

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, event] = mockPublish.mock.calls[0]!;
    expect(event.payload.refused).toBe('error');
  });

  it('never fails the request when the audit publish itself fails', async () => {
    mockPublish.mockRejectedValue(new Error('bus unavailable'));
    mockAckGrant.mockResolvedValue({
      status: 'ok', ackedAt: new Date(), ackOutcome: 'used', ownerDid: OWNER, purpose: null,
    });

    const response = await callRoute(makeRequest({ outcome: 'used' }));
    expect(response.status).toBe(200);
  });

  it('does not publish an audit event for a pure body-validation failure', async () => {
    await callRoute(makeRequest({ outcome: 'not-a-real-outcome' }));
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
