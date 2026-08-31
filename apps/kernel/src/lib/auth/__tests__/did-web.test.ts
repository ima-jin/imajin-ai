/**
 * Unit tests for did:web resolution and verification (#1900).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bs58 from 'bs58';
import { hexToMultibase, DID_WEB_RESOLUTION_TIMEOUT_MS } from '@imajin/auth';
import { didWebToUrl, documentContainsKey, resolveExternalDidVerification } from '../did-web';

const PUBLIC_KEY_HEX = 'a'.repeat(64);
const OTHER_PUBLIC_KEY_HEX = 'b'.repeat(64);

function jsonResponse(value: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => value } as unknown as Response;
}

/** A fetch that never settles on its own — only rejects once its AbortSignal fires. */
function neverSettlingUntilAborted(_url: string, init?: { signal?: AbortSignal }): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });
}

describe('didWebToUrl', () => {
  it('converts a bare domain to the .well-known form', () => {
    expect(didWebToUrl('did:web:boardy.ai')).toBe('https://boardy.ai/.well-known/did.json');
  });

  it('converts a path-based did:web to the path form, without .well-known', () => {
    expect(didWebToUrl('did:web:boardy.ai:u:alice')).toBe('https://boardy.ai/u/alice/did.json');
  });

  it('decodes a percent-encoded colon in the domain segment as a port', () => {
    expect(didWebToUrl('did:web:boardy.ai%3A3000')).toBe('https://boardy.ai:3000/.well-known/did.json');
  });

  it('decodes percent-encoded path segments', () => {
    expect(didWebToUrl('did:web:boardy.ai:u:jin%20doe')).toBe('https://boardy.ai/u/jin doe/did.json');
  });

  it('returns null for a non-did:web identifier', () => {
    expect(didWebToUrl('did:key:z6Mk')).toBeNull();
    expect(didWebToUrl('not-a-did')).toBeNull();
  });

  it('returns null for a malformed percent-encoding', () => {
    expect(didWebToUrl('did:web:boardy.ai%')).toBeNull();
  });
});

describe('documentContainsKey', () => {
  it('matches a publicKeyMultibase verification method (W3C Multikey)', () => {
    const doc = {
      verificationMethod: [
        { id: '#key-1', type: 'Ed25519VerificationKey2020', publicKeyMultibase: hexToMultibase(PUBLIC_KEY_HEX) },
      ],
    };
    expect(documentContainsKey(doc, PUBLIC_KEY_HEX)).toBe(true);
    expect(documentContainsKey(doc, OTHER_PUBLIC_KEY_HEX)).toBe(false);
  });

  it('matches a publicKeyBase58 verification method (legacy Ed25519VerificationKey2018)', () => {
    const raw = Buffer.from(PUBLIC_KEY_HEX, 'hex');
    const doc = {
      verificationMethod: [
        { id: '#key-1', type: 'Ed25519VerificationKey2018', publicKeyBase58: bs58.encode(raw) },
      ],
    };
    expect(documentContainsKey(doc, PUBLIC_KEY_HEX)).toBe(true);
  });

  it('matches a publicKeyJwk (OKP/Ed25519) verification method', () => {
    const x = Buffer.from(PUBLIC_KEY_HEX, 'hex').toString('base64url');
    const doc = {
      verificationMethod: [
        { id: '#key-1', type: 'JsonWebKey2020', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x } },
      ],
    };
    expect(documentContainsKey(doc, PUBLIC_KEY_HEX)).toBe(true);
  });

  it('matches a publicKeyHex verification method', () => {
    const doc = { verificationMethod: [{ id: '#key-1', publicKeyHex: PUBLIC_KEY_HEX.toUpperCase() }] };
    expect(documentContainsKey(doc, PUBLIC_KEY_HEX)).toBe(true);
  });

  it('is case-insensitive when comparing hex', () => {
    const doc = { verificationMethod: [{ id: '#key-1', publicKeyHex: PUBLIC_KEY_HEX.toUpperCase() }] };
    expect(documentContainsKey(doc, PUBLIC_KEY_HEX.toUpperCase())).toBe(true);
  });

  it('returns false when no verification method matches', () => {
    const doc = { verificationMethod: [{ id: '#key-1', publicKeyHex: OTHER_PUBLIC_KEY_HEX }] };
    expect(documentContainsKey(doc, PUBLIC_KEY_HEX)).toBe(false);
  });

  it('returns false for malformed/missing documents', () => {
    expect(documentContainsKey(null, PUBLIC_KEY_HEX)).toBe(false);
    expect(documentContainsKey({}, PUBLIC_KEY_HEX)).toBe(false);
    expect(documentContainsKey({ verificationMethod: 'nope' }, PUBLIC_KEY_HEX)).toBe(false);
    expect(documentContainsKey({ verificationMethod: [null, 42] }, PUBLIC_KEY_HEX)).toBe(false);
  });

  it('tolerates an unparseable multibase entry by trying other fields', () => {
    const doc = {
      verificationMethod: [
        { id: '#key-1', publicKeyMultibase: 'not-multibase', publicKeyHex: PUBLIC_KEY_HEX },
      ],
    };
    expect(documentContainsKey(doc, PUBLIC_KEY_HEX)).toBe(true);
  });
});

describe('resolveExternalDidVerification', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is declared_unverified for a non-did:web method without ever calling fetch', async () => {
    const result = await resolveExternalDidVerification('did:key:z6MkfakeKey', PUBLIC_KEY_HEX);
    expect(result.state).toBe('declared_unverified');
    expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is verified when the resolved document lists the knock key', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ verificationMethod: [{ id: '#key-1', publicKeyMultibase: hexToMultibase(PUBLIC_KEY_HEX) }] }),
    );

    const result = await resolveExternalDidVerification('did:web:boardy.ai', PUBLIC_KEY_HEX);
    expect(result.state).toBe('verified');
    expect(fetch).toHaveBeenCalledWith('https://boardy.ai/.well-known/did.json', expect.any(Object));
  });

  it('is declared_unverified (negative test) when the resolved document does NOT contain the knock key', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ verificationMethod: [{ id: '#key-1', publicKeyMultibase: hexToMultibase(OTHER_PUBLIC_KEY_HEX) }] }),
    );

    const result = await resolveExternalDidVerification('did:web:boardy.ai', PUBLIC_KEY_HEX);
    expect(result.state).toBe('declared_unverified');
  });

  it('is resolution_failed on a network error', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await resolveExternalDidVerification('did:web:boardy.ai', PUBLIC_KEY_HEX);
    expect(result.state).toBe('resolution_failed');
  });

  it('is resolution_failed on a non-OK HTTP response (e.g. missing did.json)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ error: 'not found' }, false, 404));

    const result = await resolveExternalDidVerification('did:web:boardy.ai', PUBLIC_KEY_HEX);
    expect(result.state).toBe('resolution_failed');
  });

  it('is resolution_failed when the response body is not valid JSON', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    } as unknown as Response);

    const result = await resolveExternalDidVerification('did:web:boardy.ai', PUBLIC_KEY_HEX);
    expect(result.state).toBe('resolution_failed');
  });

  it('is resolution_failed when the request times out (never fatal, never verified)', async () => {
    vi.useFakeTimers();
    try {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(neverSettlingUntilAborted);

      const promise = resolveExternalDidVerification('did:web:slow.example', PUBLIC_KEY_HEX);
      await vi.advanceTimersByTimeAsync(DID_WEB_RESOLUTION_TIMEOUT_MS);
      const result = await promise;
      expect(result.state).toBe('resolution_failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
