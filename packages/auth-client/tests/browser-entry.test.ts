/**
 * Tests for the browser-safe `@ima-jin/auth-client/browser` entry (#2643).
 *
 * Two guarantees:
 *  1. `requestAppToken` behaves identically when imported via the browser
 *     entry (same endpoint, same body, `credentials: 'include'`).
 *  2. The browser entry's import graph is client-safe — proven by actually
 *     bundling `src/browser.ts` with esbuild for a browser target, which
 *     fails on any node built-in, and by asserting on the resolved graph.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestAppToken } from '../src/browser';
import * as browserEntry from '../src/browser';
import * as rootEntry from '../src/index';

const AUTH_URL = 'https://kernel.test';
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_ENTRY = path.join(PKG_ROOT, 'src', 'browser.ts');

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function isForbiddenImport(spec: string): boolean {
  const bare = spec.replace(/^node:/, '');
  return NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(bare) || spec.startsWith('node:') || spec.startsWith('next');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestAppToken via ./browser', () => {
  it('posts to {authUrl}/auth/api/tokens/app with the same body and credentials: include', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'tok', expiresIn: 600, scopes: ['profile:read'] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await requestAppToken({ authUrl: AUTH_URL, aud: 'coffee.example.com', scopes: ['profile:read'] });

    expect(result).toEqual({ token: 'tok', expiresIn: 600, scopes: ['profile:read'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_URL}/auth/api/tokens/app`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aud: 'coffee.example.com', scopes: ['profile:read'] }),
      }),
    );
  });

  it('defaults scopes to an empty array', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 't', expiresIn: 1, scopes: [] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await requestAppToken({ authUrl: AUTH_URL, aud: 'coffee.example.com' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ aud: 'coffee.example.com', scopes: [] }) }),
    );
  });

  it('returns null on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    expect(await requestAppToken({ authUrl: AUTH_URL, aud: 'coffee.example.com' })).toBeNull();
  });

  it('returns null when the kernel is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await requestAppToken({ authUrl: AUTH_URL, aud: 'coffee.example.com' })).toBeNull();
  });

  it('is the same function the root entry exports (no breaking change for existing importers)', () => {
    expect(rootEntry.requestAppToken).toBe(browserEntry.requestAppToken);
  });

  it('exposes only requestAppToken at runtime', () => {
    expect(Object.keys(browserEntry)).toEqual(['requestAppToken']);
  });
});

describe('./browser import graph is client-safe', () => {
  it('bundles for a browser target with no node built-ins, next/*, or keystore code', async () => {
    // platform: 'browser' makes esbuild error on any node built-in import
    // (fs, crypto, path, node:*) instead of silently externalising it.
    const result = await build({
      entryPoints: [BROWSER_ENTRY],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      absWorkingDir: PKG_ROOT,
      logLevel: 'silent',
    });

    expect(result.errors).toEqual([]);

    const inputs = Object.keys(result.metafile.inputs);
    const externalImports = Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports.filter((imp) => imp.external).map((imp) => imp.path),
    );
    const allImportPaths = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((imp) => imp.path));

    expect(externalImports.filter(isForbiddenImport)).toEqual([]);
    expect(allImportPaths.filter(isForbiddenImport)).toEqual([]);

    // The graph is exactly the browser entry + app-token — nothing else pulled in.
    expect(inputs.toSorted()).toEqual(['src/app-token.ts', 'src/browser.ts']);
    for (const forbidden of ['keystore', 'load-app-signing-key', 'ed25519', 'session', 'handlers', 'get-session']) {
      expect(inputs.filter((input) => input.includes(forbidden))).toEqual([]);
    }

    const bundled = result.outputFiles.map((f) => f.text).join('\n');
    expect(bundled).not.toMatch(/next\/headers|from\s*["'](?:node:)?(?:fs|crypto|path)["']/);
  });
});

describe('./browser packaging', () => {
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

  it('declares a ./browser export with types, import and require conditions', () => {
    expect(pkg.exports['./browser']).toEqual({
      types: './dist/browser.d.ts',
      import: './dist/browser.js',
      require: './dist/browser.cjs',
    });
    expect(pkg.exports['.']).toBeDefined();
    expect(pkg.exports['./handlers']).toBeDefined();
  });

  it('is emitted by the tsup build config', () => {
    const tsupConfig = readFileSync(path.join(PKG_ROOT, 'tsup.config.ts'), 'utf8');
    expect(tsupConfig).toContain("'src/browser.ts'");
  });
});
