/**
 * Unit tests for POST /api/vault/mint (#2242).
 *
 * Covers: authority gating (unauthorized principal rejected), body
 * validation, that mint never returns private key material, and that a
 * signed mint attestation + vault.key.minted bus event are both emitted
 * with no secret material in either payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireMintAuthority, mockMintKeypair, mockEmitAttestation, mockPublish } = vi.hoisted(() => ({
  mockRequireMintAuthority: vi.fn(),
  mockMintKeypair: vi.fn(),
  mockEmitAttestation: vi.fn().mockResolvedValue({}),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/auth', () => ({
  emitAttestation: mockEmitAttestation,
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/vault', () => ({
  mintKeypair: mockMintKeypair,
}));

vi.mock('@/src/lib/vault/mint-authority', () => ({
  requireMintAuthority: mockRequireMintAuthority,
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from '../route.js';

const NODE_DID = 'did:imajin:node';
const REQUESTER = 'did:imajin:corpus-bootstrap';
const MINTED_DID = 'did:imajin:abcdef0123456789';
const PUBLIC_KEY = 'a'.repeat(64);

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/vault/mint', {
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
  mockMintKeypair.mockResolvedValue({
    mintId: 'vmk_test',
    did: MINTED_DID,
    publicKey: PUBLIC_KEY,
    field: `vault-minted-key:${MINTED_DID}`,
    grantId: 'vdg_test',
    requestId: null,
  });
});

describe('POST /api/vault/mint — authority', () => {
  it('returns the authority response verbatim when the caller is unauthorized', async () => {
    const denied = new Response(JSON.stringify({ error: 'Not authorized' }), { status: 403 });
    mockRequireMintAuthority.mockResolvedValue({ ok: false, response: denied });

    const response = await POST(makeRequest({ purpose: 'x', requesterDid: REQUESTER }));

    expect(response.status).toBe(403);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });
});

describe('POST /api/vault/mint — validation', () => {
  it('rejects a missing purpose', async () => {
    const response = await POST(makeRequest({ requesterDid: REQUESTER }));
    expect(response.status).toBe(400);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });

  it('rejects a missing requesterDid', async () => {
    const response = await POST(makeRequest({ purpose: 'corpus-identity' }));
    expect(response.status).toBe(400);
    expect(mockMintKeypair).not.toHaveBeenCalled();
  });

  it('rejects an overly long purpose', async () => {
    const response = await POST(makeRequest({ purpose: 'x'.repeat(201), requesterDid: REQUESTER }));
    expect(response.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const request = new Request('http://localhost/api/vault/mint', { method: 'POST', body: '{not json' });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/vault/mint — success', () => {
  it('returns only { did, publicKey } and never the private key', async () => {
    const response = await POST(makeRequest({ purpose: 'corpus-identity', requesterDid: REQUESTER }));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).toEqual({ did: MINTED_DID, publicKey: PUBLIC_KEY });
  });

  it('passes the acting principal as mintedBy, distinct from requesterDid', async () => {
    await POST(makeRequest({ purpose: 'corpus-identity', requesterDid: REQUESTER }));

    expect(mockMintKeypair).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'corpus-identity', requesterDid: REQUESTER, mintedBy: NODE_DID }),
    );
  });

  it('emits a vault.key.minted attestation with issuer = acting principal, subject = minted DID', async () => {
    await POST(makeRequest({ purpose: 'corpus-identity', requesterDid: REQUESTER }));

    expect(mockEmitAttestation).toHaveBeenCalledTimes(1);
    const [params] = mockEmitAttestation.mock.calls[0]!;
    expect(params.type).toBe('vault.key.minted');
    expect(params.issuer_did).toBe(NODE_DID);
    expect(params.subject_did).toBe(MINTED_DID);
    expect(JSON.stringify(params)).not.toContain('privateKey');
  });

  it('publishes a vault.key.minted bus event with no key material', async () => {
    await POST(makeRequest({ purpose: 'corpus-identity', requesterDid: REQUESTER }));

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [eventType, event] = mockPublish.mock.calls[0]!;
    expect(eventType).toBe('vault.key.minted');
    expect(event.payload.did).toBe(MINTED_DID);
    expect(event.payload.requestedBy).toBe(REQUESTER);
    expect(event.payload.mintedBy).toBe(NODE_DID);
    expect(JSON.stringify(event.payload)).not.toContain('privateKey');
  });

  it('never fails the request when the attestation or bus publish itself fails', async () => {
    mockEmitAttestation.mockRejectedValue(new Error('attestation service down'));
    mockPublish.mockRejectedValue(new Error('bus unavailable'));

    const response = await POST(makeRequest({ purpose: 'corpus-identity', requesterDid: REQUESTER }));

    expect(response.status).toBe(201);
  });

  it('returns a vault error response when mintKeypair throws', async () => {
    mockMintKeypair.mockRejectedValue(new Error('vault sealing failed'));

    const response = await POST(makeRequest({ purpose: 'corpus-identity', requesterDid: REQUESTER }));

    expect(response.status).toBe(500);
  });
});
