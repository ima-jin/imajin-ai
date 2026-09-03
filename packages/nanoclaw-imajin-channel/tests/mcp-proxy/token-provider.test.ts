import { describe, expect, it, vi } from 'vitest';
import { mintAppToken, RouteTokenProvider } from '../../src/mcp-proxy/token-provider.js';

const PRIVATE_KEY_HEX = '33'.repeat(32);

describe('mintAppToken', () => {
  it('signs a challenge and posts the expected shape', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://kernel.example.com/auth/api/apps/token');
      const body = JSON.parse(String(init?.body)) as { appDid: string; attestationId: string; scope: string; signature: string };
      expect(body.appDid).toBe('did:imajin:agent-poc');
      expect(body.attestationId).toBe('att-1');
      expect(body.scope).toBe('mcp');
      expect(body.signature.length).toBeGreaterThan(0);
      return new Response(JSON.stringify({ token: 'jwt-abc', expiresIn: 600 }), { status: 200 });
    });

    const minted = await mintAppToken(
      'https://kernel.example.com',
      'did:imajin:agent-poc',
      PRIVATE_KEY_HEX,
      'att-1',
      undefined,
      fetchMock as unknown as typeof fetch,
    );
    expect(minted).toEqual({ token: 'jwt-abc', expiresIn: 600 });
  });

  it('throws with the kernel error message on failure', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid attestation' }), { status: 403 }));
    await expect(
      mintAppToken('https://kernel.example.com', 'did:x', PRIVATE_KEY_HEX, 'att-bad', undefined, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/invalid attestation/);
  });
});

describe('RouteTokenProvider', () => {
  it('caches a token until it nears expiry, then mints a fresh one', async () => {
    let mintCount = 0;
    const fetchMock = vi.fn(async () => {
      mintCount++;
      return new Response(JSON.stringify({ token: `jwt-${mintCount}`, expiresIn: 600 }), { status: 200 });
    });

    let now = 0;
    const provider = new RouteTokenProvider(
      'https://kernel.example.com',
      'did:x',
      PRIVATE_KEY_HEX,
      'att-1',
      60_000,
      () => now,
      fetchMock as unknown as typeof fetch,
    );

    expect(await provider.getToken()).toBe('jwt-1');
    expect(await provider.getToken()).toBe('jwt-1'); // still cached
    expect(mintCount).toBe(1);

    now += 600_000 - 60_000 + 1; // past the refresh skew window
    expect(await provider.getToken()).toBe('jwt-2');
    expect(mintCount).toBe(2);
  });

  it('mints immediately after invalidate()', async () => {
    let mintCount = 0;
    const fetchMock = vi.fn(async () => {
      mintCount++;
      return new Response(JSON.stringify({ token: `jwt-${mintCount}`, expiresIn: 600 }), { status: 200 });
    });
    const provider = new RouteTokenProvider(
      'https://kernel.example.com',
      'did:x',
      PRIVATE_KEY_HEX,
      'att-1',
      60_000,
      () => 0,
      fetchMock as unknown as typeof fetch,
    );
    expect(await provider.getToken()).toBe('jwt-1');
    provider.invalidate();
    expect(await provider.getToken()).toBe('jwt-2');
  });
});
