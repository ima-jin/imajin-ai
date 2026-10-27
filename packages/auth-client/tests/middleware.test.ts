import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forwardAuthCallback } from '../src/middleware';
import { forwardAuthCallback as rootExport } from '../src/index';

const publicUrl = 'https://jin.imajin.ai/coffee';
const query = '?code=opaque%2Bvalue&state=opaque%3Astate&extra=a+b&extra=%20';

describe('forwardAuthCallback', () => {
  it.each(['/coffee', '/coffee/'])('forwards root %s with the identical query to the public callback', (path) => {
    const req = new NextRequest(`http://localhost:3000${path}${query}`);
    const response = forwardAuthCallback(req, { publicUrl });
    expect(response?.status).toBe(307);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(response?.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response?.headers.get('location')).toBe(`${publicUrl}/api/auth/callback${query}`);
    expect(req.nextUrl.pathname).toBe(path);
    expect(req.nextUrl.search).toBe(query);
  });

  it.each([
    '',
    '?attestation_id=att_123',
    '?user_did=did:imajin:alice',
    '?attestation_id=&user_did=did:imajin:alice',
    '?attestation_id=att_123&user_did=',
  ])('passes through missing or empty parameters: %s', (search) => {
    const req = new NextRequest(`${publicUrl}${search}`);
    expect(forwardAuthCallback(req, { publicUrl })).toBeNull();
    expect(req.url).toBe(`${publicUrl}${search}`);
  });

  it.each(['/coffee/dashboard', '/coffee/api/auth/callback', '/coffees', '/', '/coffee//'])(
    'never forwards another path: %s',
    (path) => {
      expect(forwardAuthCallback(new NextRequest(`https://jin.imajin.ai${path}${query}`), { publicUrl })).toBeNull();
    },
  );

  it('supports apps with no basePath', () => {
    const response = forwardAuthCallback(new NextRequest(`https://app.example/${query}`));
    expect(response?.headers.get('location')).toBe(`https://app.example/api/auth/callback${query}`);
  });

  it.each(['/coffee', '/coffee/'])('supports Next.js normalized root %s', (path) => {
    const req = new NextRequest(`http://localhost:3000${path}${query}`, {
      nextConfig: { basePath: '/coffee' },
    });
    expect(req.nextUrl.pathname).toBe('/');
    const response = forwardAuthCallback(req, { publicUrl: 'https://jin.imajin.ai' });
    expect(response?.headers.get('location')).toBe(`${publicUrl}/api/auth/callback${query}`);
  });

  it('does not forward normalized non-root paths', () => {
    const req = new NextRequest(`${publicUrl}/dashboard${query}`, { nextConfig: { basePath: '/coffee' } });
    expect(forwardAuthCallback(req, { publicUrl })).toBeNull();
  });

  it('supports explicit basePath and a trusted forwarded public origin', () => {
    const req = new NextRequest(`http://localhost:3000/coffee${query}`, {
      headers: { 'x-forwarded-host': 'dev-jin.imajin.ai, internal', 'x-forwarded-proto': 'https, http' },
    });
    const response = forwardAuthCallback(req, { basePath: '/coffee/' });
    expect(response?.headers.get('location')).toBe(`https://dev-jin.imajin.ai/coffee/api/auth/callback${query}`);
  });

  it('uses the request protocol when only the forwarded host is present', () => {
    const req = new NextRequest(`https://internal.test/coffee${query}`, {
      headers: { 'x-forwarded-host': 'jin.imajin.ai' },
    });
    expect(forwardAuthCallback(req, { basePath: '/coffee' })?.headers.get('location'))
      .toBe(`${publicUrl}/api/auth/callback${query}`);
  });

  it('prefers configured publicUrl over forwarded headers and accepts an explicit basePath', () => {
    const req = new NextRequest(`http://localhost:3000/coffee${query}`, {
      headers: { 'x-forwarded-host': 'other.example', 'x-forwarded-proto': 'http' },
    });
    expect(forwardAuthCallback(req, { publicUrl: 'https://jin.imajin.ai/', basePath: '/coffee' })?.headers.get('location'))
      .toBe(`${publicUrl}/api/auth/callback${query}`);
  });

  it('exports the helper from the root entry as well', () => {
    expect(rootExport).toBe(forwardAuthCallback);
  });
});

describe('middleware entry packaging', () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));

  it('ships middleware import, require and types exports and builds its entry', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./middleware']).toEqual({
      types: './dist/middleware.d.ts',
      import: './dist/middleware.js',
      require: './dist/middleware.cjs',
    });
    expect(readFileSync(new URL('../tsup.config.ts', import.meta.url), 'utf8')).toContain("'src/middleware.ts'");
  });

  it('bundles without Node built-ins, session secrets or keystore modules', async () => {
    const result = await build({
      entryPoints: ['src/middleware.ts'],
      absWorkingDir: packageRoot,
      bundle: true,
      platform: 'browser',
      external: ['next/server'],
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.metafile.inputs).toSorted())
      .toEqual(['src/middleware.ts', 'src/redirect-url.ts']);
  });
});
