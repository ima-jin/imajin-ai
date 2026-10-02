/**
 * Core invariant tests for .fair manifest crypto (#325).
 *
 * Pins the signing contract that every settlement and disclosure path leans on:
 *   - sign → verify round-trips (v1.0 hex and v1.1 base64url)
 *   - flipping a single byte of the signature OR the signed content fails verify
 *   - platform endorsement sign + verify, independent of the author signature
 *   - canonicalizeForSigning strips both signature fields, deterministically
 *
 * Keys are generated per-test; nothing secret is committed.
 */
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { concatBytes } from '@noble/hashes/utils';
import {
  canonicalizeForSigning,
  signManifest,
  verifyManifest,
  platformSign,
  verifyPlatformSignature,
} from '../src';
import type { FairManifest, FairManifestV11, SignedFairManifest } from '../src';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(concatBytes(...m));

// ─── Helpers ────────────────────────────────────────────────────────────────

interface TestKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  privateKeyHex: string;
  publicKeyHex: string;
  did: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function makeKey(label: string): Promise<TestKey> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return {
    privateKey,
    publicKey,
    privateKeyHex: toHex(privateKey),
    publicKeyHex: toHex(publicKey),
    did: `did:imajin:${label}`,
  };
}

/** Flip the low bit of the first byte of a hex string. */
function flipFirstHexByte(hex: string): string {
  const flipped = (Number.parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, '0');
  return flipped + hex.slice(2);
}

/** Replace one character in the middle of a base64url string with a different valid one. */
function mutateBase64urlMiddle(value: string): string {
  const i = Math.floor(value.length / 2);
  const replacement = value[i] === 'A' ? 'B' : 'A';
  return value.slice(0, i) + replacement + value.slice(i + 1);
}

function makeV10(overrides: Partial<FairManifest> = {}): FairManifest {
  return {
    fair: '1.0',
    id: 'asset_invariant_v10',
    type: 'image/png',
    owner: 'did:imajin:owner',
    created: '2026-01-01T00:00:00.000Z',
    access: 'public',
    attribution: [{ did: 'did:imajin:owner', role: 'creator', share: 1 }],
    ...overrides,
  } as FairManifest;
}

function makeV11(overrides: Partial<FairManifestV11> = {}): FairManifestV11 {
  return {
    fair: '1.1',
    version: '1.1',
    id: 'asset_invariant_v11',
    type: 'image/png',
    owner: 'did:imajin:owner',
    created: '2026-01-01T00:00:00.000Z',
    access: { type: 'public' },
    attribution: [
      { did: 'did:imajin:owner', role: 'creator', share: 0.99 },
      { role: 'platform', name: 'Imajin', share: 0.01 },
    ],
    distribution: {
      reproduction: { mode: 'allowed' },
      streaming: { mode: 'allowed' },
      derivative: { mode: 'allow-with-attribution' },
      syndication: { mode: 'allow-with-attribution' },
    },
    transfer: { allowed: true, requiresAttribution: true },
    training: { allowed: false },
    commercial: { allowed: false, contactRequired: true },
    ...overrides,
  } as FairManifestV11;
}

// ─── Sign → verify round-trip ───────────────────────────────────────────────

describe('manifest sign → verify (v1.0, hex)', () => {
  it('verifies a freshly signed manifest and resolves the key by signer DID', async () => {
    const key = await makeKey('signer');
    const signed = await signManifest(makeV10(), key.privateKeyHex, key.did);

    const requestedDids: string[] = [];
    const result = await verifyManifest(signed, async (did) => {
      requestedDids.push(did);
      return key.publicKeyHex;
    });

    expect(result).toEqual({ valid: true });
    expect(requestedDids).toEqual([key.did]);
    expect(signed.signature?.algorithm).toBe('ed25519');
    expect(signed.signature?.value).toMatch(/^[0-9a-f]{128}$/);
  });

  it('fails when one byte of the signature is flipped', async () => {
    const key = await makeKey('signer');
    const signed = await signManifest(makeV10(), key.privateKeyHex, key.did);
    const tampered: FairManifest = {
      ...signed,
      signature: { ...signed.signature!, value: flipFirstHexByte(signed.signature!.value) },
    };

    const result = await verifyManifest(tampered, async () => key.publicKeyHex);

    expect(result.valid).toBe(false);
  });

  it('fails when one byte of the signed content changes', async () => {
    const key = await makeKey('signer');
    const signed = await signManifest(makeV10({ id: 'asset_a' }), key.privateKeyHex, key.did);

    const result = await verifyManifest({ ...signed, id: 'asset_b' }, async () => key.publicKeyHex);

    expect(result).toEqual({ valid: false, error: 'Signature verification failed' });
  });

  it('fails when verified against a different key', async () => {
    const key = await makeKey('signer');
    const other = await makeKey('other');
    const signed = await signManifest(makeV10(), key.privateKeyHex, key.did);

    const result = await verifyManifest(signed, async () => other.publicKeyHex);

    expect(result.valid).toBe(false);
  });

  it('reports a missing signature rather than throwing', async () => {
    const result = await verifyManifest(makeV10(), async () => 'unused');

    expect(result).toEqual({ valid: false, error: 'No signature present' });
  });
});

describe('manifest sign → verify (v1.1, base64url)', () => {
  it('verifies a freshly signed manifest', async () => {
    const key = await makeKey('signer');
    const signed = await signManifest(makeV11(), { did: key.did, privateKey: key.privateKey });

    const result = await verifyManifest(signed, async () => key.publicKey);

    expect(result).toEqual({ ok: true });
    expect(signed.signature.signer).toBe(key.did);
  });

  it('fails when one byte of the signature is changed', async () => {
    const key = await makeKey('signer');
    const signed = await signManifest(makeV11(), { did: key.did, privateKey: key.privateKey });
    const tampered: SignedFairManifest = {
      ...signed,
      signature: { ...signed.signature, value: mutateBase64urlMiddle(signed.signature.value) },
    };

    const result = await verifyManifest(tampered, async () => key.publicKey);

    expect(result.ok).toBe(false);
  });

  it('fails when a share in the signed content changes', async () => {
    const key = await makeKey('signer');
    const signed = await signManifest(makeV11(), { did: key.did, privateKey: key.privateKey });
    const tampered: SignedFairManifest = {
      ...signed,
      attribution: [
        { did: 'did:imajin:owner', role: 'creator', share: 1 },
        { role: 'platform', name: 'Imajin', share: 0 },
      ],
    };

    const result = await verifyManifest(tampered, async () => key.publicKey);

    expect(result).toEqual({ ok: false, reason: 'Signature verification failed' });
  });
});

// ─── Platform sign + verify ─────────────────────────────────────────────────

describe('platformSign / verifyPlatformSignature', () => {
  it('round-trips a platform endorsement', async () => {
    const platform = await makeKey('platform');
    const endorsed = await platformSign(makeV10(), platform.privateKeyHex, platform.did);

    const result = await verifyPlatformSignature(endorsed, async (did) => {
      expect(did).toBe(platform.did);
      return platform.publicKeyHex;
    });

    expect(result).toEqual({ valid: true });
    expect(endorsed.platformSignature?.publicKeyRef).toBe(platform.did);
  });

  it('rejects a manifest with no platform signature', async () => {
    const result = await verifyPlatformSignature(makeV10(), async () => 'unused');

    expect(result).toEqual({ valid: false, error: 'No platform signature present' });
  });

  it('rejects when the manifest content is changed after endorsement', async () => {
    const platform = await makeKey('platform');
    const endorsed = await platformSign(makeV10({ id: 'asset_a' }), platform.privateKeyHex, platform.did);

    const result = await verifyPlatformSignature({ ...endorsed, id: 'asset_b' }, async () => platform.publicKeyHex);

    expect(result.valid).toBe(false);
  });

  it('rejects when one byte of the platform signature is flipped', async () => {
    const platform = await makeKey('platform');
    const endorsed = await platformSign(makeV10(), platform.privateKeyHex, platform.did);
    const tampered: FairManifest = {
      ...endorsed,
      platformSignature: {
        ...endorsed.platformSignature!,
        value: flipFirstHexByte(endorsed.platformSignature!.value),
      },
    };

    const result = await verifyPlatformSignature(tampered, async () => platform.publicKeyHex);

    expect(result.valid).toBe(false);
  });

  it('rejects an endorsement verified against the wrong platform key', async () => {
    const platform = await makeKey('platform');
    const impostor = await makeKey('impostor');
    const endorsed = await platformSign(makeV10(), platform.privateKeyHex, platform.did);

    const result = await verifyPlatformSignature(endorsed, async () => impostor.publicKeyHex);

    expect(result.valid).toBe(false);
  });

  it('is independent of the author signature: both verify on a doubly-signed manifest', async () => {
    const author = await makeKey('author');
    const platform = await makeKey('platform');
    const authored = await signManifest(makeV10(), author.privateKeyHex, author.did);
    const both = await platformSign(authored, platform.privateKeyHex, platform.did);

    expect(await verifyManifest(both, async () => author.publicKeyHex)).toEqual({ valid: true });
    expect(await verifyPlatformSignature(both, async () => platform.publicKeyHex)).toEqual({ valid: true });
  });

  it('endorsing first, then author-signing, still verifies both', async () => {
    const author = await makeKey('author');
    const platform = await makeKey('platform');
    const endorsed = await platformSign(makeV10(), platform.privateKeyHex, platform.did);
    const both = await signManifest(endorsed, author.privateKeyHex, author.did);

    expect(await verifyManifest(both, async () => author.publicKeyHex)).toEqual({ valid: true });
    expect(await verifyPlatformSignature(both, async () => platform.publicKeyHex)).toEqual({ valid: true });
  });
});

// ─── canonicalizeForSigning ─────────────────────────────────────────────────

describe('canonicalizeForSigning', () => {
  const sig = { algorithm: 'ed25519' as const, value: 'ab'.repeat(64), publicKeyRef: 'did:imajin:x' };

  it('strips both signature and platformSignature', () => {
    const canonical = canonicalizeForSigning(makeV10({ signature: sig, platformSignature: sig }));

    expect(canonical).not.toContain('"signature"');
    expect(canonical).not.toContain('"platformSignature"');
    expect(canonical).not.toContain(sig.value);
  });

  it('is identical for unsigned, author-signed, platform-signed, and doubly-signed manifests', () => {
    const unsigned = canonicalizeForSigning(makeV10());

    expect(canonicalizeForSigning(makeV10({ signature: sig }))).toBe(unsigned);
    expect(canonicalizeForSigning(makeV10({ platformSignature: sig }))).toBe(unsigned);
    expect(canonicalizeForSigning(makeV10({ signature: sig, platformSignature: sig }))).toBe(unsigned);
  });

  it('is deterministic regardless of key insertion order', () => {
    const a = makeV10();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as FairManifest;

    expect(canonicalizeForSigning(reordered)).toBe(canonicalizeForSigning(a));
  });

  it('emits compact JSON with sorted keys', () => {
    const canonical = canonicalizeForSigning(makeV10());

    // JSON.parse preserves key order, so re-stringifying is byte-identical only when already compact.
    expect(JSON.stringify(JSON.parse(canonical))).toBe(canonical);
    expect(canonical.startsWith('{"access":')).toBe(true);
  });

  it('does not mutate the manifest it is given', () => {
    const manifest = makeV10({ signature: sig, platformSignature: sig });

    canonicalizeForSigning(manifest);

    expect(manifest.signature).toEqual(sig);
    expect(manifest.platformSignature).toEqual(sig);
  });

  it('still changes when signed content changes', () => {
    expect(canonicalizeForSigning(makeV10({ id: 'a' }))).not.toBe(canonicalizeForSigning(makeV10({ id: 'b' })));
  });
});
