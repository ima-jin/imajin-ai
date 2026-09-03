import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, parseSessionCookie } from '../../src/auth/challenge-response.js';

describe('parseSessionCookie', () => {
  it('extracts name=value from a Set-Cookie header', () => {
    expect(parseSessionCookie('session=abc123; Path=/; HttpOnly; SameSite=Lax')).toBe('session=abc123');
  });

  it('throws when there is no Set-Cookie header', () => {
    expect(() => parseSessionCookie(null)).toThrow(/no session cookie/);
  });

  it('throws when the header cannot be parsed', () => {
    expect(() => parseSessionCookie('garbage-no-equals')).toThrow(/could not parse/);
  });
});

describe('authenticate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs challenge -> sign -> verify and returns the session cookie', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/api/login/challenge')) {
        const body = JSON.parse(String(init?.body)) as { did: string };
        expect(body.did).toBe('did:imajin:agent-poc');
        return new Response(JSON.stringify({ challengeId: 'chal-1', challenge: 'cafebabe' }), { status: 200 });
      }
      if (url.endsWith('/auth/api/login/verify')) {
        const body = JSON.parse(String(init?.body)) as { challengeId: string; signature: string };
        expect(body.challengeId).toBe('chal-1');
        expect(typeof body.signature).toBe('string');
        expect(body.signature.length).toBeGreaterThan(0);
        return new Response(null, { status: 200, headers: { 'set-cookie': 'session=xyz; Path=/; HttpOnly' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await authenticate(
      { kernelBaseUrl: 'https://kernel.example.com', did: 'did:imajin:agent-poc', privateKeyHex: '11'.repeat(32) },
      fetchMock as unknown as typeof fetch,
    );

    expect(result.cookie).toBe('session=xyz');
  });

  it('throws when the challenge request fails', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(
      authenticate(
        { kernelBaseUrl: 'https://kernel.example.com', did: 'did:imajin:agent-poc', privateKeyHex: '11'.repeat(32) },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Auth challenge failed/);
  });

  it('throws when the verify request fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/api/login/challenge')) {
        return new Response(JSON.stringify({ challengeId: 'c', challenge: 'x' }), { status: 200 });
      }
      return new Response(null, { status: 401 });
    });
    await expect(
      authenticate(
        { kernelBaseUrl: 'https://kernel.example.com', did: 'did:imajin:agent-poc', privateKeyHex: '11'.repeat(32) },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Auth verify failed/);
  });
});
