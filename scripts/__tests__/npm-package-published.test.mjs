/**
 * Tests for scripts/npm-package-published.mjs (#2578) — the skip-if-already-
 * published check scripts/publish-package.sh runs before `npm publish`.
 *
 * No real registry is contacted: the logic is tested with an injected
 * `fetch`, and the CLI is exercised end-to-end against a throwaway local HTTP
 * server standing in for the registry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { check, lookupVersion, packumentUrl } from '../npm-package-published.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../npm-package-published.mjs', import.meta.url));
const REGISTRY = 'https://registry.example.test';
const NAME = '@ima-jin/logger';
const VERSION = '0.8.14';
// Generated per run so no credential-shaped literal lives in the repo.
const TOKEN = randomUUID();

function preparedPackage(manifest = { name: NAME, version: VERSION }) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-published-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

/** A fetch stand-in that answers every request with the given status/body. */
function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      json: async () => {
        if (body instanceof Error) throw body;
        return body;
      },
    };
  };
}

describe('packumentUrl', () => {
  it('encodes the scope separator and tolerates trailing slashes on the registry', () => {
    expect(packumentUrl('https://registry.npmjs.org', NAME)).toBe('https://registry.npmjs.org/@ima-jin%2Flogger');
    expect(packumentUrl('https://npm.pkg.github.com//', NAME)).toBe('https://npm.pkg.github.com/@ima-jin%2Flogger');
  });
});

describe('lookupVersion', () => {
  it('is published when the packument lists the exact version', async () => {
    const result = await lookupVersion({
      name: NAME,
      version: VERSION,
      registry: REGISTRY,
      fetchImpl: fakeFetch(200, { versions: { '0.8.7': {}, [VERSION]: {} } }),
    });
    expect(result).toBe('published');
  });

  it('is unpublished when the package exists but not at that version', async () => {
    const result = await lookupVersion({
      name: NAME,
      version: VERSION,
      registry: REGISTRY,
      fetchImpl: fakeFetch(200, { versions: { '0.8.7': {} } }),
    });
    expect(result).toBe('unpublished');
  });

  it('does not match inherited object keys as versions', async () => {
    const result = await lookupVersion({
      name: NAME,
      version: 'toString',
      registry: REGISTRY,
      fetchImpl: fakeFetch(200, { versions: {} }),
    });
    expect(result).toBe('unpublished');
  });

  it('is unpublished on 404 (the package was never published)', async () => {
    const result = await lookupVersion({
      name: NAME,
      version: VERSION,
      registry: REGISTRY,
      fetchImpl: fakeFetch(404, null),
    });
    expect(result).toBe('unpublished');
  });

  it.each([401, 403, 429, 500, 503])('throws on HTTP %s rather than guessing', async (status) => {
    await expect(
      lookupVersion({ name: NAME, version: VERSION, registry: REGISTRY, fetchImpl: fakeFetch(status, null) }),
    ).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([
    ['a body that is not JSON', new SyntaxError('Unexpected token')],
    ['a body with no versions map', {}],
    ['a null versions map', { versions: null }],
    ['a null body', null],
  ])('throws on 200 with %s', async (_label, body) => {
    await expect(
      lookupVersion({ name: NAME, version: VERSION, registry: REGISTRY, fetchImpl: fakeFetch(200, body) }),
    ).rejects.toThrow();
  });

  it('propagates network failures', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(lookupVersion({ name: NAME, version: VERSION, registry: REGISTRY, fetchImpl })).rejects.toThrow(
      'fetch failed',
    );
  });

  it('asks for the abbreviated packument and sends the token only when one is given', async () => {
    const withToken = [];
    await lookupVersion({
      name: NAME,
      version: VERSION,
      registry: REGISTRY,
      token: TOKEN,
      fetchImpl: fakeFetch(404, null, withToken),
    });
    expect(withToken[0].url).toBe(`${REGISTRY}/@ima-jin%2Flogger`);
    expect(withToken[0].init.headers).toEqual({
      Accept: 'application/vnd.npm.install-v1+json',
      Authorization: `Bearer ${TOKEN}`,
    });

    const withoutToken = [];
    await lookupVersion({
      name: NAME,
      version: VERSION,
      registry: REGISTRY,
      fetchImpl: fakeFetch(404, null, withoutToken),
    });
    expect(withoutToken[0].init.headers).toEqual({ Accept: 'application/vnd.npm.install-v1+json' });
  });
});

describe('check', () => {
  it('reads name@version from the prepared copy and reports published (exit 0)', async () => {
    const calls = [];
    const result = await check([preparedPackage(), REGISTRY], {
      fetchImpl: fakeFetch(200, { versions: { [VERSION]: {} } }, calls),
    });

    expect(result).toEqual({ code: 0, out: 'published', err: '' });
    expect(calls[0].url).toBe(`${REGISTRY}/@ima-jin%2Flogger`);
  });

  it('reports unpublished (exit 0) so the publish proceeds', async () => {
    const result = await check([preparedPackage(), REGISTRY], { fetchImpl: fakeFetch(404, null) });
    expect(result).toEqual({ code: 0, out: 'unpublished', err: '' });
  });

  it('fails (exit 1) when the state cannot be determined, naming the package and registry but never the token', async () => {
    const result = await check([preparedPackage(), REGISTRY], { token: TOKEN, fetchImpl: fakeFetch(503, null) });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain(`${NAME}@${VERSION}`);
    expect(result.err).toContain(REGISTRY);
    expect(result.err).toContain('HTTP 503');
    expect(result.err).not.toContain(TOKEN);
  });

  it('requires both arguments', async () => {
    expect((await check([])).code).toBe(1);
    expect((await check([preparedPackage()])).code).toBe(1);
    expect((await check([])).err).toContain('usage');
  });

  it('fails when the package.json is missing or unparseable', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'npm-published-empty-'));
    expect((await check([empty, REGISTRY])).err).toContain('cannot read');

    const broken = mkdtempSync(join(tmpdir(), 'npm-published-broken-'));
    writeFileSync(join(broken, 'package.json'), '{not json');
    expect((await check([broken, REGISTRY])).code).toBe(1);
  });

  it.each([
    ['name', { version: '1.0.0' }],
    ['version', { name: '@ima-jin/x' }],
  ])('fails when the manifest has no %s, without querying the registry', async (_field, manifest) => {
    const calls = [];
    const result = await check([preparedPackage(manifest), REGISTRY], { fetchImpl: fakeFetch(200, {}, calls) });

    expect(result.code).toBe(1);
    expect(result.err).toContain('no name/version');
    expect(calls).toHaveLength(0);
  });
});

describe('CLI against a local registry', () => {
  let server;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
  });

  /** Starts a registry stand-in; returns its URL and the requests it saw. */
  async function startRegistry(respond) {
    const seen = [];
    server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization, accept: req.headers.accept });
      respond(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, seen };
  }

  function run(registryUrl, extraEnv = {}) {
    const { NODE_AUTH_TOKEN: _ignored, ...inherited } = process.env;
    const env = { ...inherited, ...extraEnv };
    return execFileAsync(process.execPath, [SCRIPT, preparedPackage(), registryUrl], { env }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  }

  it('prints `published` and exits 0 for a version already on the registry, sending the bearer token', async () => {
    const { url, seen } = await startRegistry((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ versions: { [VERSION]: {} } }));
    });

    const result = await run(url, { NODE_AUTH_TOKEN: TOKEN });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('published');
    expect(seen).toEqual([
      { url: '/@ima-jin%2Flogger', authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.npm.install-v1+json' },
    ]);
  });

  it('prints `unpublished` and exits 0 on 404', async () => {
    const { url } = await startRegistry((_req, res) => {
      res.statusCode = 404;
      res.end('{}');
    });

    const result = await run(url);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('unpublished');
  });

  it('exits 1 with a message on stderr (and nothing on stdout) when the registry errors', async () => {
    const { url } = await startRegistry((_req, res) => {
      res.statusCode = 503;
      res.end('down');
    });

    const result = await run(url);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cannot determine');
    expect(result.stderr).toContain('HTTP 503');
  });

  it('exits 1 with usage when called without arguments', async () => {
    const result = await execFileAsync(process.execPath, [SCRIPT]).then(
      ({ stderr }) => ({ code: 0, stderr }),
      (error) => ({ code: error.code, stderr: error.stderr }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('usage');
  });
});
