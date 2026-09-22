/**
 * Unit tests for POST /api/vault/mint/revoke (#2242).
 *
 * Covers: authority gating, missing/invalid body, not-found vs
 * already-revoked vs freshly-revoked outcomes, and that the revoke
 * attestation + bus event carry no key material.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireMintAuthority, mockRevokeMintedKey, mockEmitAttestation, mockPublish } = vi.hoisted(() => ({
  mockRequireMintAuthority: vi.fn(),
  mockRevokeMintedKey: vi.fn(),
  mockEmitAttestation: vi.fn().mockResolvedValue({}),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/auth', () => ({
  emitAttestation: mockEmitAttestation,
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/vault', () => ({
  revokeMintedKey: mockRevokeMintedKey,
}));

vi.mock('@/src/lib/vault/mint-authority', () => ({
  requireMintAuthority: mockRequireMintAuthority,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from '../route.js';

const NODE_DID = 'did:imajin:node';
const MINTED_DID = 'did:imajin:abcdef0123456789';
const PUBLIC_KEY = 'a'.repeat(64);

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/vault/mint/revoke', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMintAuthority.mockResolvedValue({
    ok: true,
    authority: { actingDid: NODE_DID, composedBy: null },
  });
});

describe('POST /api/vault/mint/revoke — authority', () => {
  it('returns the authority response verbatim when the caller is unauthorized', async () => {
    const denied = new Response(JSON.stringify({ error: 'Not authorized' }), { status: 403 });
    mockRequireMintAuthority.mockResolvedValue({ ok: false, response: denied });

    const response = await POST(makeRequest({ did: MINTED_DID }));

    expect(response.status).toBe(403);
    expect(mockRevokeMintedKey).not.toHaveBeenCalled();
  });
});

describe('POST /api/vault/mint/revoke — validation', () => {
  it('rejects a missing did', async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    expect(mockRevokeMintedKey).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const request = new Request('http://localhost/api/vault/mint/revoke', { method: 'POST', body: '{not json' });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/vault/mint/revoke — outcomes', () => {
  it('returns 404 when the DID was never minted', async () => {
    mockRevokeMintedKey.mockResolvedValue({ status: 'not_found' });

    const response = await POST(makeRequest({ did: MINTED_DID }));

    expect(response.status).toBe(404);
    expect(mockEmitAttestation).not.toHaveBeenCalled();
  });

  it('returns ok + alreadyRevoked without re-emitting an attestation', async () => {
    mockRevokeMintedKey.mockResolvedValue({
      status: 'already_revoked',
      record: { id: 'vmk_test', did: MINTED_DID, publicKey: PUBLIC_KEY },
    });

    const response = await POST(makeRequest({ did: MINTED_DID }));
    const body = await response.json() as { ok: boolean; alreadyRevoked: boolean };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.alreadyRevoked).toBe(true);
    expect(mockEmitAttestation).not.toHaveBeenCalled();
  });

  it('revokes, emits a vault.key.revoked attestation with no key material, and publishes a matching bus event', async () => {
    mockRevokeMintedKey.mockResolvedValue({
      status: 'revoked',
      record: { id: 'vmk_test', did: MINTED_DID, publicKey: PUBLIC_KEY },
    });

    const response = await POST(makeRequest({ did: MINTED_DID }));
    const body = await response.json() as { ok: boolean; did: string; mintId: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.did).toBe(MINTED_DID);

    expect(mockEmitAttestation).toHaveBeenCalledTimes(1);
    const [params] = mockEmitAttestation.mock.calls[0]!;
    expect(params.type).toBe('vault.key.revoked');
    expect(params.issuer_did).toBe(NODE_DID);
    expect(params.subject_did).toBe(MINTED_DID);
    expect(JSON.stringify(params)).not.toContain('privateKey');

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [eventType, event] = mockPublish.mock.calls[0]!;
    expect(eventType).toBe('vault.key.revoked');
    expect(event.payload.did).toBe(MINTED_DID);
    expect(event.payload.revokedBy).toBe(NODE_DID);
  });

  it('never fails the request when the attestation or bus publish itself fails', async () => {
    mockRevokeMintedKey.mockResolvedValue({
      status: 'revoked',
      record: { id: 'vmk_test', did: MINTED_DID, publicKey: PUBLIC_KEY },
    });
    mockEmitAttestation.mockRejectedValue(new Error('attestation service down'));
    mockPublish.mockRejectedValue(new Error('bus unavailable'));

    const response = await POST(makeRequest({ did: MINTED_DID }));

    expect(response.status).toBe(200);
  });
});
