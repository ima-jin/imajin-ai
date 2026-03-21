import { describe, it, expect } from 'vitest';
import {
  generateKeypair,
  hexToMultibase,
  multibaseToHex,
  bytesToMultibase,
  multibaseToPubkey,
  hexToBytes,
} from '@imajin/auth';
import { createIdentityChain, verifyChain, createSigner } from '@imajin/dfos';
import { signContentOperation, verifyContentChain } from '@metalabel/dfos-protocol';
import * as ed25519Noble from '@noble/ed25519';

// ─── Section 1: Key format round-trips ───────────────────────────────────────

describe('key format conversion', () => {
  it('hex → multibase → hex round-trip', () => {
    const { publicKey } = generateKeypair();
    const multibase = hexToMultibase(publicKey);
    const back = multibaseToHex(multibase);
    expect(back).toBe(publicKey);
  });

  it('bytes → multibase → bytes round-trip', () => {
    const { publicKey } = generateKeypair();
    const bytes = hexToBytes(publicKey);
    const multibase = bytesToMultibase(bytes);
    const back = multibaseToPubkey(multibase);
    expect(Buffer.from(back)).toEqual(Buffer.from(bytes));
  });

  it('produces z6Mk prefix (Ed25519 multikey convention)', () => {
    const { publicKey } = generateKeypair();
    const multibase = hexToMultibase(publicKey);
    expect(multibase).toMatch(/^z6Mk/);
  });

  it('rejects invalid hex (odd length)', () => {
    expect(() => hexToMultibase('abc')).toThrow();
  });

  it('rejects invalid multibase (wrong prefix)', () => {
    expect(() => multibaseToPubkey('x6MkInvalid')).toThrow();
  });

  it('rejects invalid multibase (invalid base58 characters)', () => {
    // '!' is not a valid base58btc character
    expect(() => multibaseToPubkey('zNotValidBase58!!!')).toThrow();
  });
});

// ─── Section 2: Chain creation ───────────────────────────────────────────────

describe('identity chain creation', () => {
  it('creates a chain that verifies', async () => {
    const keypair = generateKeypair();
    const result = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    expect(result.did).toMatch(/^did:dfos:/);
    expect(result.log).toHaveLength(1);
    expect(result.operationCID).toBeTruthy();

    // Verify with DFOS protocol's own verifier
    const verified = await verifyChain(result.log);
    expect(verified.did).toBe(result.did);
    expect(verified.isDeleted).toBe(false);
    expect(verified.controllerKeys).toHaveLength(1);
  });

  it('different keypairs produce different DIDs', async () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();

    const chain1 = await createIdentityChain({
      privateKeyHex: kp1.privateKey,
      publicKeyHex: kp1.publicKey,
    });
    const chain2 = await createIdentityChain({
      privateKeyHex: kp2.privateKey,
      publicKeyHex: kp2.publicKey,
    });

    expect(chain1.did).not.toBe(chain2.did);
  });

  it('genesis has all three key roles populated', async () => {
    const keypair = generateKeypair();
    const { log } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const verified = await verifyChain(log);
    expect(verified.authKeys).toHaveLength(1);
    expect(verified.assertKeys).toHaveLength(1);
    expect(verified.controllerKeys).toHaveLength(1);

    // All three roles use the same key material
    expect(verified.authKeys[0].publicKeyMultibase)
      .toBe(verified.controllerKeys[0].publicKeyMultibase);
  });

  it('DID format matches did:dfos spec (22-char custom alphabet)', async () => {
    const keypair = generateKeypair();
    const { did } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const id = did.replace('did:dfos:', '');
    expect(id).toHaveLength(22);
    expect(id).toMatch(/^[2346789acdefhknrtvz]+$/);
  });
});

// ─── Section 3: Signer adapter ───────────────────────────────────────────────

describe('signer adapter', () => {
  it('produces valid Ed25519 signatures', async () => {
    const keypair = generateKeypair();
    const signer = createSigner(keypair.privateKey);
    const message = new TextEncoder().encode('test message');

    const signature = await signer(message);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(64);

    // Verify with noble/curves directly
    const pubBytes = hexToBytes(keypair.publicKey);
    const valid = ed25519Noble.verify(signature, message, pubBytes);
    expect(valid).toBe(true);
  });
});

// ─── Section 3b: Identity chain storage format ────────────────────────────────

describe('identity chain storage format', () => {
  it('chain log survives JSON round-trip (simulates DB storage)', async () => {
    const keypair = generateKeypair();
    const chain = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const serialized = JSON.stringify(chain.log);
    const deserialized = JSON.parse(serialized);

    const verified = await verifyChain(deserialized);
    expect(verified.did).toBe(chain.did);
  });

  it('operationCID is a valid CID string', async () => {
    const keypair = generateKeypair();
    const chain = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    expect(chain.operationCID).toMatch(/^[a-z2-7]+$/);
    expect(chain.operationCID.length).toBeGreaterThan(10);
  });

  it('chain key matches input public key (server verification test)', async () => {
    const keypair = generateKeypair();
    const chain = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const verified = await verifyChain(chain.log);
    const chainKeyMultibase = verified.controllerKeys[0].publicKeyMultibase;
    const expectedMultibase = hexToMultibase(keypair.publicKey);

    expect(chainKeyMultibase).toBe(expectedMultibase);
  });
});

// ─── Section 4: Cross-protocol verification ──────────────────────────────────

describe('cross-protocol verification', () => {
  it('DFOS chain exports a key that round-trips to the original hex', async () => {
    const keypair = generateKeypair();

    const { log } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const verified = await verifyChain(log);
    const dfosMultibase = verified.controllerKeys[0].publicKeyMultibase;

    // Convert back to hex using our bridge utility
    const recoveredHex = multibaseToHex(dfosMultibase);
    expect(recoveredHex).toBe(keypair.publicKey);
  });

  it('Imajin signer creates valid DFOS content chain operations', async () => {
    const keypair = generateKeypair();
    const { did: dfosDid, log: identityLog } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const verified = await verifyChain(identityLog);
    const keyId = verified.authKeys[0].id;
    const kid = `${dfosDid}#${keyId}`;
    const signer = createSigner(keypair.privateKey);

    const contentOp = {
      version: 1 as const,
      type: 'create' as const,
      did: dfosDid,
      documentCID: 'bafyreihash1234567890abcdefghijklmnopqrstuvwxyz12345678',
      baseDocumentCID: null,
      createdAt: new Date().toISOString(),
      note: null,
    };

    const { jwsToken } = await signContentOperation({
      operation: contentOp,
      signer,
      kid,
    });

    // Resolve the key from the verified identity (simulating a resolver)
    const { decodeMultikey } = await import('@metalabel/dfos-protocol');
    const multibase = verified.controllerKeys[0].publicKeyMultibase;
    const { keyBytes } = decodeMultikey(multibase);

    const contentChain = await verifyContentChain({
      log: [jwsToken],
      resolveKey: async () => keyBytes,
    });

    expect(contentChain.contentId).toBeTruthy();
    expect(contentChain.isDeleted).toBe(false);
  });
});
