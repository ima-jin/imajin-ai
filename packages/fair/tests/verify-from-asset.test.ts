import { describe, it, expect } from 'vitest';
import { verifyManifestFromAsset } from '@imajin/fair';
import { signManifest, canonicalize } from '@imajin/fair';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { concatBytes } from '@noble/hashes/utils';

// Enable sync sha512 for ed25519 key generation
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(concatBytes(...m));

// ─── Helpers ───────────────────────────────────────────────────────────────

async function generateKeypair(): Promise<{ did: string; privateKey: Uint8Array; publicKey: Uint8Array }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    did: `did:imajin:test_${bytesToHex(publicKey).slice(0, 16)}`,
    privateKey,
    publicKey,
  };
}

function mockResponse(opts: {
  ok?: boolean;
  headers?: Record<string, string>;
  body?: unknown;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  return {
    ok: opts.ok ?? true,
    headers,
    text: () => Promise.resolve(JSON.stringify(opts.body)),
    json: () => Promise.resolve(opts.body),
  } as Response;
}

function makeDigest(manifest: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalize(manifest))))}`;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('verifyManifestFromAsset', () => {
  it('happy path: verifies signed manifest with DFOS anchor', async () => {
    const signer = await generateKeypair();
    const manifest = {
      fair: '1.1',
      id: 'asset_test123',
      kind: 'image',
      creator: signer.did,
      created: '2026-05-10T20:00:00.000Z',
      access: { type: 'public' },
    };

    const signed = await signManifest(manifest, signer);
    const digest = makeDigest(signed);

    const fetchAsset = async (url: string) => {
      if (url === 'https://example.com/media/api/assets/asset_test123') {
        return mockResponse({
          ok: true,
          headers: {
            link: '</media/api/assets/asset_test123/fair>; rel="fair"; type="application/fair+json"',
            'x-fair-digest': digest,
            'x-fair-dfos': 'dfos:event:evt_abc123',
          },
        });
      }
      if (url.includes('/fair')) {
        return mockResponse({ ok: true, body: signed });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await verifyManifestFromAsset(
      'https://example.com/media/api/assets/asset_test123',
      {
        fetchAsset,
        resolveOwnerKey: async () => signer.publicKey,
        fetchDfosEvent: async () => ({
          topic: 'fair.manifest.published',
          payload: {
            assetId: 'asset_test123',
            ownerDid: signer.did,
            manifestDigest: digest,
            manifestUrl: 'https://example.com/media/api/assets/asset_test123/fair',
            fairVersion: '1.1',
            signedAt: '2026-05-10T20:00:00.000Z',
          },
          anchoredAt: '2026-05-10T20:01:00.000Z',
          signature: 'sig_placeholder',
        }),
      },
    );

    expect(result.valid).toBe(true);
    expect(result.signedAt).toBeTruthy();
    expect(result.anchorTimestamp).toBe('2026-05-10T20:01:00.000Z');
    expect(result.owner).toBe(signer.did);
  });

  it('rejects when Link header is missing', async () => {
    const fetchAsset = async () =>
      mockResponse({
        ok: true,
        headers: {},
      });

    const result = await verifyManifestFromAsset('https://example.com/asset', {
      fetchAsset,
      resolveOwnerKey: async () => new Uint8Array(32),
      fetchDfosEvent: async () => null,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Missing Link');
  });

  it('rejects when manifest signature is tampered', async () => {
    const signer = await generateKeypair();
    const manifest = {
      fair: '1.1',
      id: 'asset_test123',
      kind: 'image',
      creator: signer.did,
      created: '2026-05-10T20:00:00.000Z',
      access: { type: 'public' },
    };

    const signed = await signManifest(manifest, signer);
    // Tamper with the manifest
    signed.id = 'asset_tampered';
    const digest = makeDigest(signed);

    const fetchAsset = async (url: string) => {
      if (!url.includes('/fair')) {
        return mockResponse({
          ok: true,
          headers: {
            link: '</media/api/assets/asset_test123/fair>; rel="fair"',
            'x-fair-digest': digest,
          },
        });
      }
      return mockResponse({ ok: true, body: signed });
    };

    const result = await verifyManifestFromAsset('https://example.com/asset', {
      fetchAsset,
      resolveOwnerKey: async () => signer.publicKey,
      fetchDfosEvent: async () => null,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Signature verification failed');
  });

  it('rejects when digest does not match', async () => {
    const signer = await generateKeypair();
    const manifest = {
      fair: '1.1',
      id: 'asset_test123',
      kind: 'image',
      creator: signer.did,
      created: '2026-05-10T20:00:00.000Z',
      access: { type: 'public' },
    };

    const signed = await signManifest(manifest, signer);

    const fetchAsset = async (url: string) => {
      if (!url.includes('/fair')) {
        return mockResponse({
          ok: true,
          headers: {
            link: '</media/api/assets/asset_test123/fair>; rel="fair"',
            'x-fair-digest': 'sha256:bad000000000000000000000000000000000000000000000000000000000bad',
          },
        });
      }
      return mockResponse({ ok: true, body: signed });
    };

    const result = await verifyManifestFromAsset('https://example.com/asset', {
      fetchAsset,
      resolveOwnerKey: async () => signer.publicKey,
      fetchDfosEvent: async () => null,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Digest mismatch');
  });

  it('passes without DFOS anchor when header is absent', async () => {
    const signer = await generateKeypair();
    const manifest = {
      fair: '1.1',
      id: 'asset_test123',
      kind: 'image',
      creator: signer.did,
      created: '2026-05-10T20:00:00.000Z',
      access: { type: 'public' },
    };

    const signed = await signManifest(manifest, signer);
    const digest = makeDigest(signed);

    const fetchAsset = async (url: string) => {
      if (!url.includes('/fair')) {
        return mockResponse({
          ok: true,
          headers: {
            link: '</media/api/assets/asset_test123/fair>; rel="fair"',
            'x-fair-digest': digest,
            // No x-fair-dfos
          },
        });
      }
      return mockResponse({ ok: true, body: signed });
    };

    const result = await verifyManifestFromAsset('https://example.com/asset', {
      fetchAsset,
      resolveOwnerKey: async () => signer.publicKey,
      fetchDfosEvent: async () => null,
    });

    expect(result.valid).toBe(true);
    expect(result.anchorTimestamp).toBeUndefined();
  });

  it('rejects when DFOS event digest mismatches', async () => {
    const signer = await generateKeypair();
    const manifest = {
      fair: '1.1',
      id: 'asset_test123',
      kind: 'image',
      creator: signer.did,
      created: '2026-05-10T20:00:00.000Z',
      access: { type: 'public' },
    };

    const signed = await signManifest(manifest, signer);
    const digest = makeDigest(signed);

    const fetchAsset = async (url: string) => {
      if (!url.includes('/fair')) {
        return mockResponse({
          ok: true,
          headers: {
            link: '</media/api/assets/asset_test123/fair>; rel="fair"',
            'x-fair-digest': digest,
            'x-fair-dfos': 'dfos:event:evt_abc123',
          },
        });
      }
      return mockResponse({ ok: true, body: signed });
    };

    const result = await verifyManifestFromAsset('https://example.com/asset', {
      fetchAsset,
      resolveOwnerKey: async () => signer.publicKey,
      fetchDfosEvent: async () => ({
        topic: 'fair.manifest.published',
        payload: {
          manifestDigest: 'sha256:wrongdigest0000000000000000000000000000000000000000000000000000',
        },
        anchoredAt: '2026-05-10T20:01:00.000Z',
        signature: 'sig_placeholder',
      }),
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('DFOS event manifestDigest does not match');
  });
});
