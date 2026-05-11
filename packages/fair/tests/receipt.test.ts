import { describe, it, expect } from 'vitest';
import { signReceipt, verifyReceipt, loadSigningKey, loadVerifyKey } from '../src/receipt';

// Deterministic test key — 32-byte hex (ed25519 raw seed per RFC 8032)
const TEST_KEY_HEX = 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';

describe('signReceipt / verifyReceipt', () => {
  it('round-trips a valid receipt', async () => {
    const signKey = await loadSigningKey(TEST_KEY_HEX);
    const verifyKey = await loadVerifyKey(TEST_KEY_HEX);

    const token = await signReceipt(
      {
        aud: 'asset:test123',
        sub: 'stl_abc123',
        buyer: 'did:imajin:buyer1',
        action: 'reproduction',
        amount: 500,
        currency: 'USD',
        manifestDigest: 'sha256:deadbeef',
      },
      signKey,
    );

    const decoded = await verifyReceipt(token, verifyKey);
    expect(decoded).not.toBeNull();
    expect(decoded!.aud).toBe('asset:test123');
    expect(decoded!.sub).toBe('stl_abc123');
    expect(decoded!.buyer).toBe('did:imajin:buyer1');
    expect(decoded!.action).toBe('reproduction');
    expect(decoded!.amount).toBe(500);
    expect(decoded!.currency).toBe('USD');
    expect(decoded!.manifestDigest).toBe('sha256:deadbeef');
    expect(decoded!.iss).toBe('node');
    expect(decoded!.exp).toBeGreaterThan(decoded!.iat);
  });

  it('rejects a tampered token', async () => {
    const signKey = await loadSigningKey(TEST_KEY_HEX);
    const verifyKey = await loadVerifyKey(TEST_KEY_HEX);

    let token = await signReceipt(
      {
        aud: 'asset:test123',
        sub: 'stl_abc123',
        buyer: 'did:imajin:buyer1',
        action: 'reproduction',
        amount: 500,
        currency: 'USD',
        manifestDigest: 'sha256:deadbeef',
      },
      signKey,
    );

    // Tamper with the payload
    token = token.slice(0, -5) + 'XXXXX';

    const decoded = await verifyReceipt(token, verifyKey);
    expect(decoded).toBeNull();
  });

  it('rejects token with wrong issuer', async () => {
    const signKey = await loadSigningKey(TEST_KEY_HEX);
    const verifyKey = await loadVerifyKey(TEST_KEY_HEX);

    // Manually craft a JWT with wrong issuer via jose
    const { SignJWT } = await import('jose');
    const badToken = await new SignJWT({ action: 'reproduction', amount: 100, currency: 'USD', manifestDigest: 'sha256:x' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('attacker')
      .setAudience('asset:test')
      .setSubject('stl_x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signKey);

    const decoded = await verifyReceipt(badToken, verifyKey);
    expect(decoded).toBeNull();
  });

  it('rejects expired token', async () => {
    const signKey = await loadSigningKey(TEST_KEY_HEX);
    const verifyKey = await loadVerifyKey(TEST_KEY_HEX);

    const now = Math.floor(Date.now() / 1000);
    const token = await signReceipt(
      {
        aud: 'asset:test123',
        sub: 'stl_abc123',
        buyer: 'did:imajin:buyer1',
        action: 'reproduction',
        amount: 500,
        currency: 'USD',
        manifestDigest: 'sha256:deadbeef',
        iat: now - 3600,
        exp: now - 1800,
      },
      signKey,
    );

    const decoded = await verifyReceipt(token, verifyKey);
    expect(decoded).toBeNull();
  });

  it('returns null for malformed token', async () => {
    const verifyKey = await loadVerifyKey(TEST_KEY_HEX);
    const decoded = await verifyReceipt('not.a.jwt', verifyKey);
    expect(decoded).toBeNull();
  });

  it('rejects receipt with missing or non-DID buyer claim', async () => {
    const signKey = await loadSigningKey(TEST_KEY_HEX);
    const verifyKey = await loadVerifyKey(TEST_KEY_HEX);

    // Manually craft a JWT without buyer claim
    const { SignJWT } = await import('jose');
    const noBuyer = await new SignJWT({
      action: 'reproduction',
      amount: 100,
      currency: 'USD',
      manifestDigest: 'sha256:x',
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('node')
      .setAudience('asset:test')
      .setSubject('stl_x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signKey);
    expect(await verifyReceipt(noBuyer, verifyKey)).toBeNull();

    // Non-DID buyer claim
    const badBuyer = await new SignJWT({
      buyer: 'not-a-did',
      action: 'reproduction',
      amount: 100,
      currency: 'USD',
      manifestDigest: 'sha256:x',
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('node')
      .setAudience('asset:test')
      .setSubject('stl_x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signKey);
    expect(await verifyReceipt(badBuyer, verifyKey)).toBeNull();
  });
});
