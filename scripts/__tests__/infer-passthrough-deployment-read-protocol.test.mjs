import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDeliveryRequest, openDeliveryResponse, PURPOSE, REPOSITORY, sealDeliveryResponse,
  signingKey, signingPublicKey, verifyDeliveryRequest,
} from '../../deploy/infer-passthrough/deployment-read-protocol.mjs';

const host = generateKeyPairSync('ed25519').privateKey;
const kernel = generateKeyPairSync('ed25519').privateKey;
const stranger = generateKeyPairSync('ed25519').privateKey;
const binding = { repository: REPOSITORY, ownerDid: 'did:imajin:owner', recipientDid: `did:imajin:${signingPublicKey(host).slice(0, 16)}` };
const path = '/api/vault/delegation/grants/vdg_fixture/fetch';
const fixture = 'test-credential-not-a-token';

describe('deployment-read restricted transport', () => {
  it('authenticates the recipient and encrypts exclusively to the signed ephemeral holder', () => {
    const request = createDeliveryRequest('POST', path, '', binding, host);
    const claim = verifyDeliveryRequest(request.header, 'POST', path, '', binding, signingPublicKey(host));
    const envelope = sealDeliveryResponse({ value: fixture }, claim, Date.now() + 30_000, kernel);
    expect(openDeliveryResponse(envelope, request, signingPublicKey(kernel))).toEqual({ value: fixture });
    expect(JSON.stringify([envelope, request.header])).not.toContain(fixture);
    const otherRequest = createDeliveryRequest('POST', path, '', binding, host);
    expect(() => openDeliveryResponse(envelope, otherRequest, signingPublicKey(kernel))).toThrow();
    expect(() => openDeliveryResponse(envelope, { ...request, privateKey: otherRequest.privateKey }, signingPublicKey(kernel))).toThrow();
  });

  it.each([
    ['repository', 'ima-jin/other'], ['ownerDid', 'did:imajin:stranger'],
    ['recipientDid', 'did:imajin:other'], ['purpose', 'other-purpose'],
    ['nonce', 'invalid'], ['ephemeralKey', 'invalid'], ['timestamp', 0],
    ['timestamp', 'not-a-date'], ['signature', 'invalid'],
  ])('refuses tampered %s', (field, value) => {
    const request = createDeliveryRequest('POST', path, '', binding, host);
    const claim = JSON.parse(Buffer.from(request.header, 'base64url').toString());
    const header = Buffer.from(JSON.stringify({ ...claim, [field]: value })).toString('base64url');
    expect(() => verifyDeliveryRequest(header, 'POST', path, '', binding, signingPublicKey(host))).toThrow();
  });

  it.each([
    ['GET', path, ''], ['POST', `${path}?different=1`, ''], ['POST', path, '{"different":true}'],
  ])('binds method, path and body: %s %s', (method, target, body) => {
    const request = createDeliveryRequest('POST', path, '', binding, host);
    expect(() => verifyDeliveryRequest(request.header, method, target, body, binding, signingPublicKey(host))).toThrow();
  });

  it('refuses an unrecognized signing identity, expired request and malformed header', () => {
    const request = createDeliveryRequest('POST', path, '', binding, stranger);
    expect(() => verifyDeliveryRequest(request.header, 'POST', path, '', binding, signingPublicKey(host))).toThrow();
    const stale = createDeliveryRequest('POST', path, '', binding, host, Date.now() - 61_000);
    for (const header of [stale.header, null, '', '!', 'x'.repeat(4097)]) {
      expect(() => verifyDeliveryRequest(header, 'POST', path, '', binding, signingPublicKey(host))).toThrow();
    }
    expect(() => signingKey('not-a-key')).toThrow();
  });

  it.each(['context', 'senderKey', 'nonce', 'ciphertext', 'tag', 'signature'])('refuses altered response %s', field => {
    const request = createDeliveryRequest('POST', path, '', binding, host);
    const envelope = sealDeliveryResponse({ value: fixture }, request.claim, Date.now() + 30_000, kernel);
    expect(() => openDeliveryResponse({ ...envelope, [field]: 'invalid' }, request, signingPublicKey(kernel))).toThrow();
  });

  it('enforces pinned witness, freshness and request lifetime on signed responses', () => {
    const request = createDeliveryRequest('POST', path, '', binding, host);
    const now = Date.now();
    const envelope = sealDeliveryResponse({ value: fixture }, request.claim, now + 1000, kernel);
    expect(() => openDeliveryResponse(envelope, request, signingPublicKey(stranger))).toThrow();
    expect(() => openDeliveryResponse(envelope, request, signingPublicKey(kernel), now + 1001)).toThrow();
    const overlong = sealDeliveryResponse({}, request.claim, now + 120_000, kernel);
    expect(() => openDeliveryResponse(overlong, request, signingPublicKey(kernel))).toThrow();
    expect(request.claim.purpose).toBe(PURPOSE);
  });
});
