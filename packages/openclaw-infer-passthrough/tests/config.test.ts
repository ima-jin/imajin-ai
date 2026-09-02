import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadRoutes, resolveDirectApiKey } from '../src/config.js';

function writeRoutes(dir: string, routes: unknown): string {
  const path = join(dir, 'routes.json');
  writeFileSync(path, JSON.stringify(routes));
  return path;
}

describe('loadRoutes', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loads a valid route table', () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-proxy-'));
    const path = writeRoutes(dir, [
      { id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-xai', modelPrefixes: ['grok-'] },
    ]);
    const routes = loadRoutes(path);
    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe('xai');
  });

  it('rejects a route missing a required field', () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-proxy-'));
    const path = writeRoutes(dir, [{ id: 'xai', principalDid: 'did:imajin:ryan' }]);
    expect(() => loadRoutes(path)).toThrow(/attestationId/);
  });

  it('rejects duplicate route ids', () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-proxy-'));
    const path = writeRoutes(dir, [
      { id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-1' },
      { id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-2' },
    ]);
    expect(() => loadRoutes(path)).toThrow(/duplicate route id/);
  });

  it('rejects a non-array config', () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-proxy-'));
    const path = writeRoutes(dir, { not: 'an array' });
    expect(() => loadRoutes(path)).toThrow(/must be a JSON array/);
  });

  it('throws a clear error for a missing file, without leaking any secret env content', () => {
    expect(() => loadRoutes('/nonexistent/path/routes.json')).toThrow(/Could not read routes config/);
  });
});

describe('loadConfig', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('applies defaults for host/port/timeouts when omitted', () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-proxy-'));
    const routesPath = writeRoutes(dir, [{ id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-1' }]);
    const config = loadConfig({
      INFER_PROXY_ROUTES_CONFIG: routesPath,
      KERNEL_BASE_URL: 'https://kernel.test',
      OPENCLAW_APP_DID: 'did:imajin:app',
      OPENCLAW_APP_PRIVATE_KEY: 'deadbeef',
    } as unknown as NodeJS.ProcessEnv);

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.kernelTimeoutMs).toBe(20_000);
    expect(config.directTimeoutMs).toBe(20_000);
    expect(config.routes).toHaveLength(1);
  });

  it('throws a descriptive error when a required env var is missing, and the message never echoes any secret value', () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-proxy-'));
    const routesPath = writeRoutes(dir, [{ id: 'xai', principalDid: 'did:imajin:ryan', attestationId: 'att-1' }]);
    expect(() =>
      loadConfig({
        INFER_PROXY_ROUTES_CONFIG: routesPath,
        KERNEL_BASE_URL: 'https://kernel.test',
        OPENCLAW_APP_DID: 'did:imajin:app',
        // OPENCLAW_APP_PRIVATE_KEY intentionally omitted
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow('OPENCLAW_APP_PRIVATE_KEY is required (see packages/openclaw-infer-passthrough/README.md)');
  });
});

describe('resolveDirectApiKey', () => {
  it('returns undefined when the route has no directApiKeyEnvVar', () => {
    expect(resolveDirectApiKey({ id: 'xai', principalDid: 'd', attestationId: 'a' }, {})).toBeUndefined();
  });

  it('returns undefined when the named env var is unset', () => {
    expect(
      resolveDirectApiKey({ id: 'xai', principalDid: 'd', attestationId: 'a', directApiKeyEnvVar: 'XAI_DIRECT_API_KEY' }, {}),
    ).toBeUndefined();
  });

  it('resolves the key from the named env var', () => {
    expect(
      resolveDirectApiKey(
        { id: 'xai', principalDid: 'd', attestationId: 'a', directApiKeyEnvVar: 'XAI_DIRECT_API_KEY' },
        { XAI_DIRECT_API_KEY: 'sk-direct' } as NodeJS.ProcessEnv,
      ),
    ).toBe('sk-direct');
  });
});
