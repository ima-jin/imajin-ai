import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify,
} from 'node:crypto';

export const PURPOSE = 'infer-passthrough/github-deploy-read';
export const REPOSITORY = 'ima-jin/imajin-ai';
export const HEADER = 'x-imajin-deployment-read';
const DOMAIN = 'imajin-deployment-read-v1';
const MAX_AGE = 60_000;
const HEX = /^[a-f0-9]{64}$/;
const ED_PREFIX = '302a300506032b6570032100';
const X_PREFIX = '302a300506032b656e032100';

function publicKey(hex, prefix) {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error('Invalid public key');
  return createPublicKey({ key: Buffer.from(prefix + hex, 'hex'), format: 'der', type: 'spki' });
}

export function signingKey(seed) {
  if (typeof seed !== 'string' || !HEX.test(seed)) throw new Error('Invalid signing identity');
  return createPrivateKey({
    key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'),
    format: 'der', type: 'pkcs8',
  });
}

export function signingPublicKey(key) {
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

function message(method, path, body, claim) {
  return Buffer.from(JSON.stringify([
    DOMAIN, method, path, createHash('sha256').update(body).digest('hex'),
    claim.repository, claim.ownerDid, claim.recipientDid, claim.purpose,
    claim.nonce, claim.timestamp, claim.ephemeralKey,
  ]));
}

export function createDeliveryRequest(method, path, body, binding, key, now = Date.now()) {
  const ephemeral = generateKeyPairSync('x25519');
  const claim = {
    ...binding, purpose: PURPOSE, nonce: randomBytes(32).toString('hex'), timestamp: now,
    ephemeralKey: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
  };
  const signature = sign(null, message(method, path, body, claim), key).toString('base64');
  return {
    header: Buffer.from(JSON.stringify({ ...claim, signature })).toString('base64url'),
    claim, privateKey: ephemeral.privateKey,
  };
}

export function verifyDeliveryRequest(header, method, path, body, binding, recipientPublicKey, now = Date.now()) {
  if (typeof header !== 'string' || header.length > 4096) throw new Error('Invalid delivery request');
  const claim = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  if (claim?.repository !== REPOSITORY || claim.repository !== binding.repository
    || claim.ownerDid !== binding.ownerDid || claim.recipientDid !== binding.recipientDid
    || claim.purpose !== PURPOSE || !HEX.test(claim.nonce) || !HEX.test(claim.ephemeralKey)
    || !Number.isSafeInteger(claim.timestamp) || Math.abs(now - claim.timestamp) > MAX_AGE
    || typeof claim.signature !== 'string' || claim.signature.length > 128
    || !verify(null, message(method, path, body, claim), publicKey(recipientPublicKey, ED_PREFIX),
      Buffer.from(claim.signature, 'base64'))) throw new Error('Invalid delivery authority');
  return claim;
}

function responseContext(claim, expiresAt) {
  return JSON.stringify([DOMAIN, claim.repository, claim.ownerDid, claim.recipientDid,
    claim.purpose, claim.nonce, claim.ephemeralKey, expiresAt]);
}

function transportKey(privateKey, peer, context) {
  const shared = diffieHellman({ privateKey, publicKey: publicKey(peer, X_PREFIX) });
  try {
    return Buffer.from(hkdfSync('sha256', shared, DOMAIN, context, 32));
  } finally {
    shared.fill(0);
  }
}

/** Replayed requests yield ciphertext only the original ephemeral holder can open. */
export function sealDeliveryResponse(value, claim, expiresAt, key) {
  const context = responseContext(claim, expiresAt);
  const ephemeral = generateKeyPairSync('x25519');
  const secret = transportKey(ephemeral.privateKey, claim.ephemeralKey, context);
  const plaintext = Buffer.from(JSON.stringify(value));
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(Buffer.from(context));
    const payload = {
      context, senderKey: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
      nonce: nonce.toString('hex'),
      ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'),
      tag: cipher.getAuthTag().toString('hex'),
    };
    return { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64') };
  } finally {
    secret.fill(0);
    plaintext.fill(0);
  }
}

export function openDeliveryResponse(envelope, request, kernelPublicKey, now = Date.now()) {
  if (!envelope || typeof envelope !== 'object') throw new Error('Invalid delivery response');
  const { context, senderKey, nonce, ciphertext, tag, signature } = envelope;
  if (typeof context !== 'string' || context.length > 4096
    || typeof nonce !== 'string' || !/^[a-f0-9]{24}$/.test(nonce)
    || typeof tag !== 'string' || !/^[a-f0-9]{32}$/.test(tag)
    || typeof ciphertext !== 'string' || ciphertext.length > 131072
    || typeof signature !== 'string' || signature.length > 128
    || !verify(null, Buffer.from(JSON.stringify({ context, senderKey, nonce, ciphertext, tag })),
      publicKey(kernelPublicKey, ED_PREFIX), Buffer.from(signature, 'base64'))) {
    throw new Error('Invalid delivery provenance');
  }
  const decoded = JSON.parse(context);
  const expiresAt = decoded.at(-1);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > request.claim.timestamp + MAX_AGE
    || context !== responseContext(request.claim, expiresAt)) throw new Error('Stale or mismatched delivery');
  const secret = transportKey(request.privateKey, senderKey, context);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(nonce, 'hex'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } finally {
    secret.fill(0);
    plaintext?.fill(0);
  }
}
