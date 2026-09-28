/**
 * Unit tests for `verifyBootstrapFetchAuth` (#2411, restart-authentication
 * ruling): resolves the bound bootstrap key, verifies the signature, and
 * enforces timestamp freshness + nonce replay protection. Covers the
 * issue's required cases: wrong bootstrap key -> refused, replayed nonce ->
 * refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeypair, crypto as authCrypto } from '@imajin/auth';

const { resolveActiveBootstrapBindingMock, logMock } = vi.hoisted(() => ({
  resolveActiveBootstrapBindingMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => logMock }));
vi.mock('../signing-key-claims', () => ({
  resolveActiveBootstrapBinding: resolveActiveBootstrapBindingMock,
}));

import {
  verifyBootstrapFetchAuth,
  canonicalizeBootstrapFetchPayload,
  _resetBootstrapFetchNonceGuardForTests,
} from '../bootstrap-fetch-auth';

const APP_DID = 'did:imajin:app-under-test';
const GRANT_ID = 'vdg_app_self_1';
const SLUG = 'dykil';

const keypair = generateKeypair();
const otherKeypair = generateKeypair();

function bindingFor(publicKey: string) {
  return { slug: SLUG, appDid: APP_DID, grantId: GRANT_ID, boundPublicKey: publicKey };
}

function signedRequest(privateKey: string, overrides: Partial<{ appDid: string; timestamp: number; nonce: string }> = {}) {
  const appDid = overrides.appDid ?? APP_DID;
  const timestamp = overrides.timestamp ?? Date.now();
  const nonce = overrides.nonce ?? `nonce-${Math.random()}`;
  const signature = authCrypto.signSync(canonicalizeBootstrapFetchPayload({ appDid, nonce, timestamp }), privateKey);
  return { appDid, timestamp, nonce, signature };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetBootstrapFetchNonceGuardForTests();
  resolveActiveBootstrapBindingMock.mockResolvedValue(bindingFor(keypair.publicKey));
});

describe('verifyBootstrapFetchAuth', () => {
  it('accepts a freshly signed, well-formed request', async () => {
    const req = signedRequest(keypair.privateKey);

    const outcome = await verifyBootstrapFetchAuth(req);

    expect(outcome).toEqual({ status: 'ok', binding: bindingFor(keypair.publicKey) });
  });

  it('refuses when no bootstrap key is bound for the app', async () => {
    resolveActiveBootstrapBindingMock.mockResolvedValue(null);
    const req = signedRequest(keypair.privateKey);

    const outcome = await verifyBootstrapFetchAuth(req);

    expect(outcome).toEqual({ status: 'no_binding' });
  });

  // #2411 required test: wrong bootstrap key.
  it('refuses a request signed with the WRONG bootstrap key', async () => {
    const req = signedRequest(otherKeypair.privateKey); // signed with a different key than the bound one

    const outcome = await verifyBootstrapFetchAuth(req);

    expect(outcome).toEqual({ status: 'invalid_signature' });
  });

  it('refuses a tampered payload (signature no longer matches)', async () => {
    const req = signedRequest(keypair.privateKey);

    const outcome = await verifyBootstrapFetchAuth({ ...req, appDid: 'did:imajin:someone-else' });

    expect(outcome).toEqual({ status: 'invalid_signature' });
  });

  it('refuses a stale timestamp far in the past', async () => {
    const req = signedRequest(keypair.privateKey, { timestamp: Date.now() - 10 * 60_000 });

    const outcome = await verifyBootstrapFetchAuth(req);

    expect(outcome).toEqual({ status: 'stale_timestamp' });
  });

  it('refuses a timestamp far in the future', async () => {
    const req = signedRequest(keypair.privateKey, { timestamp: Date.now() + 10 * 60_000 });

    const outcome = await verifyBootstrapFetchAuth(req);

    expect(outcome).toEqual({ status: 'stale_timestamp' });
  });

  // #2411 required test: replayed nonce.
  it('refuses a REPLAYED nonce on a second identical request', async () => {
    const req = signedRequest(keypair.privateKey);

    expect((await verifyBootstrapFetchAuth(req)).status).toBe('ok');
    const replay = await verifyBootstrapFetchAuth(req);

    expect(replay).toEqual({ status: 'replayed_nonce' });
  });

  it('accepts two requests with different nonces from the same key', async () => {
    const first = signedRequest(keypair.privateKey);
    const second = signedRequest(keypair.privateKey);

    expect((await verifyBootstrapFetchAuth(first)).status).toBe('ok');
    expect((await verifyBootstrapFetchAuth(second)).status).toBe('ok');
  });
});
