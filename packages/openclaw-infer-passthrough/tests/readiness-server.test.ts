import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { generateKeypair } from '@imajin/auth';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/server.js';
import { checkRouteMints } from '../src/readiness.js';
import { NoLiveGrantError, TokenMintError } from '../src/token-provider.js';

let server: ReturnType<typeof createProxyServer>;
let baseUrl: string;
let mintStatus: number;
let mints: Record<string, unknown>[];
let now: number;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mintStatus = 200;
  mints = [];
  server = createProxyServer(loadConfig({
    KERNEL_BASE_URL: 'https://kernel.test',
    OPENCLAW_APP_DID: 'did:imajin:app',
    OPENCLAW_APP_PRIVATE_KEY: generateKeypair().privateKey,
    INFER_PROXY_PRINCIPAL_DID: 'did:imajin:principal',
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(baseUrl)) return realFetch(url, init);
    expect(url).toBe('https://kernel.test/auth/api/apps/token');
    mints.push(JSON.parse(init!.body as string));
    return Response.json(mintStatus === 200
      ? { token: 'test-token', expiresIn: 600, scopes: ['infer:completions', 'media:read'] }
      : { code: 'no_live_grant', error: 'untrusted upstream detail' }, { status: mintStatus });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('mint-proving readiness (#3041)', () => {
  it('boots with no grant ID and mints every configured route, retaining cache on both health aliases', async () => {
    for (const path of ['/health', '/healthz']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({
        ok: true,
        routes: ['openai', 'anthropic', 'mcp'].map((route) => ({ route, ok: true })),
      });
    }
    expect(mints).toHaveLength(3);
    for (const body of mints) {
      expect(body.principalDid).toBe('did:imajin:principal');
      expect(body).not.toHaveProperty('attestationId');
      expect(body).not.toHaveProperty('grantId');
    }
    expect(mints[2]).toMatchObject({ aud: 'https://mcp.imajin.ai/mcp' });
    expect(mints[2]).not.toHaveProperty('scope');
  });

  it.each([401, 403, 500])('fails closed on a %s mint, names every failed route and recovers after consent without edits', async (status) => {
    mintStatus = status;
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.routes).toHaveLength(3);
    for (const route of body.routes) {
      expect(route.ok).toBe(false);
      expect(route.message).toContain(status === 403 ? '/jin → Grants' : 'check');
    }
    expect(JSON.stringify(body)).not.toContain('untrusted upstream detail');
    mintStatus = 200;
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect(mints).toHaveLength(6);
  });

  it('does not report ready from expired tokens when a refresh fails', async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    now += 601_000;
    mintStatus = 403;
    expect((await fetch(`${baseUrl}/health`)).status).toBe(503);
    expect(mints).toHaveLength(6);
  });

  it('fails readiness if even one route fails, without leaking its token or error', async () => {
    const result = await checkRouteMints([{ id: 'ok', principalDid: 'p' }, { id: 'bad', principalDid: 'p' }], (id) => ({
      invalidate() {},
      getToken: async () => {
        if (id === 'bad') throw new Error('untrusted detail');
        return 'test-token';
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.routes[0]).toEqual({ route: 'ok', ok: true });
    expect(result.routes[1]).toMatchObject({ route: 'bad', ok: false });
    expect(JSON.stringify(result)).not.toMatch(/untrusted detail|test-token/);
  });

  it('does not claim an empty route table is ready', async () => {
    expect((await checkRouteMints([], vi.fn())).ok).toBe(false);
  });

  it.each(['code', 'error'])('soft-fails only an unregistered MCP audience reported as %s, through both health aliases', async (field) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(baseUrl)) return realFetch(url, init);
      const body = JSON.parse(init!.body as string);
      return body.aud
        ? Response.json({ [field]: 'app_not_registered' }, { status: 403 })
        : Response.json({ token: 'test-token', expiresIn: 600, scopes: ['infer:completions'] });
    }));
    for (const path of ['/health', '/healthz']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.routes.slice(0, 2)).toEqual(['openai', 'anthropic'].map((route) => ({ route, ok: true })));
      expect(body.routes[2]).toMatchObject({ route: 'mcp', ok: true, skipped: true });
      expect(body.routes[2].message).toContain('not a registered active kernel app');
      expect(body.routes[2].message).not.toContain('re-grant');
    }
  });

  it.each([
    ['openai', new TokenMintError(403, 'untrusted', 'app_not_registered'), 'register the audience'],
    ['anthropic', new TokenMintError(403, 'untrusted', 'app_not_registered'), 'register the audience'],
    ['mcp', new NoLiveGrantError(), '/jin → Grants'],
    ['mcp', new TokenMintError(403, 'untrusted'), 'granted scopes'],
    ['mcp', new TokenMintError(401, 'untrusted'), 'signing credentials'],
    ['mcp', new TokenMintError(500, 'untrusted', 'app_not_registered'), 'kernel connectivity'],
    ['mcp', new Error('untrusted'), 'kernel connectivity'],
  ])('still gates %s and gives a typed remedy for %s', async (id, error, remedy) => {
    const result = await checkRouteMints([{ id, principalDid: 'p' }], () => ({
      invalidate() {},
      getToken: async () => { throw error; },
    }));
    expect(result.ok).toBe(false);
    expect(result.routes[0]).toMatchObject({ route: id, ok: false });
    expect(JSON.stringify(result)).toContain(remedy);
    expect(JSON.stringify(result)).not.toContain('untrusted');
    if (!(error instanceof NoLiveGrantError)) expect(JSON.stringify(result)).not.toContain('re-grant');
  });

  it('warns once for legacy environment and route IDs together without retaining values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      KERNEL_BASE_URL: 'https://kernel.test',
      OPENCLAW_APP_DID: 'did:imajin:app',
      OPENCLAW_APP_PRIVATE_KEY: generateKeypair().privateKey,
      INFER_PROXY_PRINCIPAL_DID: 'did:imajin:principal',
      INFER_PROXY_GRANT_ID: 'obsolete-grant',
      OPENCLAW_ATTESTATION_ID: 'obsolete-attestation',
    };
    const config = loadConfig(env);
    expect(JSON.stringify(config)).not.toMatch(/obsolete-grant|obsolete-attestation/);
    const legacy = createProxyServer({ ...config, routes: [{ ...config.routes[0], attestationId: 'obsolete-route' }] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ignored');
    expect(warn.mock.calls[0][0]).not.toMatch(/obsolete-/);
    legacy.close();
  });
});
