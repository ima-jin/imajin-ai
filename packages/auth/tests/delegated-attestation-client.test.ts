/**
 * Tests for `submitDelegatedAttestation` (#2394) — the SDK helper a
 * registered third-party app uses to sign and submit an attestation
 * delegated by one of its end users.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { submitDelegatedAttestation } from '../src/delegated-attestation-client';
import { generateKeypair, verifySync } from '../src/crypto';
import { canonicalize } from '../src/sign';

const AUTH_URL = 'https://kernel.test/auth';
const APP_DID = 'did:imajin:app-dykil';
const DELEGATOR = 'did:imajin:respondent';
const SUBJECT = 'did:imajin:survey-doc-1';

function baseInput(overrides: Partial<Parameters<typeof submitDelegatedAttestation>[0]> = {}) {
  const { privateKey } = generateKeypair();
  return {
    authUrl: AUTH_URL,
    appToken: 'scoped-app-token',
    appDid: APP_DID,
    appPrivateKey: privateKey,
    delegatorDid: DELEGATOR,
    subjectDid: SUBJECT,
    type: 'survey_response',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitDelegatedAttestation — request shape', () => {
  it('POSTs to {authUrl}/api/attestations with the scoped app-token as Authorization: Bearer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1' }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await submitDelegatedAttestation(baseInput());

    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_URL}/api/attestations`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer scoped-app-token' }),
      }),
    );
  });

  it('sends issuer_did as the app\'s own DID and merges delegator_did into payload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1' }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await submitDelegatedAttestation(baseInput({ payload: { answer: 'yes' } }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      issuer_did: APP_DID,
      subject_did: SUBJECT,
      type: 'survey_response',
      payload: { answer: 'yes', delegator_did: DELEGATOR },
    });
  });

  it('signs a canonical payload the kernel route can verify with the app\'s own public key', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1' }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const issuedAt = 1700000000000;
    await submitDelegatedAttestation(baseInput({ appPrivateKey: privateKey, issuedAt }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const canonicalPayload = canonicalize({
      subject_did: SUBJECT,
      type: 'survey_response',
      context_id: null,
      context_type: null,
      payload: { delegator_did: DELEGATOR },
      issued_at: issuedAt,
    });

    expect(verifySync(body.signature, canonicalPayload, publicKey)).toBe(true);
  });

  it('defaults context_id/context_type to null when omitted', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1' }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await submitDelegatedAttestation(baseInput());

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ context_id: null, context_type: null });
  });
});

describe('submitDelegatedAttestation — response handling', () => {
  it('resolves ok:true with the created attestation on 2xx', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1', delegatorDid: DELEGATOR }), { status: 201 })) as unknown as typeof fetch;

    const result = await submitDelegatedAttestation(baseInput());

    expect(result).toEqual({ ok: true, status: 201, attestation: { id: 'att_1', delegatorDid: DELEGATOR } });
  });

  it('resolves ok:false with the server error message on a non-2xx response (e.g. missing grant)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'No live delegation grant from "..." covers "attest:app_x:survey_response"' }), { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await submitDelegatedAttestation(baseInput());

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/delegation grant/);
  });

  it('resolves ok:false when the network request itself fails', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await submitDelegatedAttestation(baseInput());

    expect(result).toEqual({ ok: false, status: 0, error: 'network down' });
  });
});
