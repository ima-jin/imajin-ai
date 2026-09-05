import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { createAccessClaimMiddleware } from '../access-claim';
import { mintTestClaimHeader } from '../../__tests__/support/mint-test-claim';

const ORIGINAL_KERNEL_PUBLIC_KEY = process.env.CORPUS_KERNEL_PUBLIC_KEY;

const KERNEL_KEYPAIR = authCrypto.generateKeypair();
const OTHER_KEYPAIR = authCrypto.generateKeypair();

function buildApp() {
  const app = express();
  app.use('/corpus/:did', createAccessClaimMiddleware());
  app.get('/corpus/:did/status', (_request, response) => {
    response.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  process.env.CORPUS_KERNEL_PUBLIC_KEY = KERNEL_KEYPAIR.publicKey;
});

afterEach(() => {
  if (ORIGINAL_KERNEL_PUBLIC_KEY === undefined) delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
  else process.env.CORPUS_KERNEL_PUBLIC_KEY = ORIGINAL_KERNEL_PUBLIC_KEY;
});

describe('createAccessClaimMiddleware', () => {
  it('passes a valid claim through to the route', async () => {
    const app = buildApp();
    const header = mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did: 'did:example:alice' });

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('rejects a missing Authorization header with 401', async () => {
    const app = buildApp();

    const response = await request(app).get('/corpus/did:example:alice/status');

    expect(response.status).toBe(401);
  });

  it('rejects an expired claim with 401', async () => {
    const app = buildApp();
    const issuedAt = Date.now() - 120_000;
    const header = mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, {
      did: 'did:example:alice',
      issuedAt,
      expiresAt: issuedAt + 60_000,
    });

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(401);
  });

  it('rejects a claim with the wrong audience with 401', async () => {
    const app = buildApp();
    const header = mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did: 'did:example:alice', aud: 'media' });

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(401);
  });

  it('rejects a claim with an unsupported alg with 401', async () => {
    const app = buildApp();
    const header = mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did: 'did:example:alice', alg: 'HS256' });

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(401);
  });

  it('rejects a claim missing alg entirely with 401', async () => {
    const app = buildApp();
    const issuedAt = Date.now();
    // Built by hand (not via mintTestClaimHeader, which always fills in `alg`)
    // so the encoded claim genuinely lacks the field, not just an override.
    const claimWithoutAlg = {
      did: 'did:example:alice',
      scope: 'corpus:read',
      aud: 'corpus',
      issuerDid: 'did:imajin:test-kernel',
      issuedAt,
      expiresAt: issuedAt + 60_000,
      nonce: 'no-alg-nonce',
    };
    const encodedClaim = Buffer.from(canonicalize(claimWithoutAlg), 'utf8').toString('base64url');
    const signature = authCrypto.signSync(encodedClaim, KERNEL_KEYPAIR.privateKey);
    const header = `Imajin-Claim ${encodedClaim}.${signature}`;

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(401);
  });

  it('rejects a claim signed by an untrusted key with 401', async () => {
    const app = buildApp();
    const header = mintTestClaimHeader(OTHER_KEYPAIR.privateKey, { did: 'did:example:alice' });

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(401);
  });

  it('rejects a claim whose subject DID does not match the path with 403', async () => {
    const app = buildApp();
    const header = mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did: 'did:example:bob' });

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(403);
  });

  it('rejects a replayed nonce on the second use with 401', async () => {
    const app = buildApp();
    const header = mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did: 'did:example:alice', nonce: 'fixed-nonce' });

    const first = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);
    const second = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('rejects when the corpus service has no trusted kernel public key configured', async () => {
    delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    const app = buildApp();
    const header = mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did: 'did:example:alice' });

    const response = await request(app).get('/corpus/did:example:alice/status').set('Authorization', header);

    expect(response.status).toBe(401);
  });
});
