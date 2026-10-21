import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ content: 'paths:\n  /api/read:\n    get: {}', truncated: false, apps: vi.fn() }));
vi.mock('../../kernel/api-specs', () => ({
  listApiSpecServices: () => ['auth'],
  readApiSpec: () => ({ content: state.content, truncated: state.truncated }),
  SPEC_MAX_CHARS: 400_000,
}));
vi.mock('../edge-registry', () => ({ listRegisteredEdgeApps: state.apps }));
vi.mock('../edge-spec-loader', () => ({ loadRegistryEdgeSpec: vi.fn().mockRejectedValue(new Error('fixture unavailable')) }));
import { deriveHostManifests } from '../classification';

function directory() {
  const root = mkdtempSync(join(tmpdir(), 'edge-discovery-'));
  mkdirSync(join(root, 'app/api'), { recursive: true });
  writeFileSync(join(root, 'app/api/route.ts'), 'export function GET(){ return Response.json({}); }');
  return root;
}
afterEach(() => { vi.unstubAllEnvs(); state.truncated = false; state.content = 'paths:\n  /api/read:\n    get: {}'; });

describe('registry-derived app spec coverage', () => {
  it('includes registered apps omitted from the static service catalogue without kernel self-calls', async () => {
    const loader = vi.fn().mockResolvedValue({ paths: { '/api/health': { get: {} } } });
    const result = await deriveHostManifests('example.test', {
      kernelDirectory: directory(), kernelOrigin: 'https://jin.example.test', loadExternalSpec: loader,
      registeredApps: [{ slug: 'coffee', baseUrl: '/coffee' }, { slug: 'links', baseUrl: 'https://links.example.test' },
        { slug: 'jin', baseUrl: '/' }, { slug: 'elsewhere', baseUrl: 'https://unrelated.invalid' }],
    });
    expect(loader).toHaveBeenCalledWith('https://jin.example.test/coffee/api/spec');
    expect(loader).toHaveBeenCalledWith('https://links.example.test/api/spec');
    expect(loader).not.toHaveBeenCalledWith('https://jin.example.test/api/spec');
    expect(loader).not.toHaveBeenCalledWith('https://jin.example.test/auth/api/spec');
    expect(loader).not.toHaveBeenCalledWith('https://unrelated.invalid/api/spec');
    expect(result.manifests.flatMap(manifest => manifest.routes).some(route => route.path === '/coffee/api/health')).toBe(true);
  });
  it('retains unknown app bases and failed specs as explicit blocking evidence', async () => {
    const result = await deriveHostManifests('example.test', {
      kernelDirectory: directory(), kernelOrigin: 'https://jin.example.test',
      loadExternalSpec: vi.fn().mockRejectedValue(new Error('fixture failure')),
      registeredApps: [{ slug: 'coffee', baseUrl: null }, { slug: 'links', baseUrl: '/links' }],
    });
    expect(result.manifests.flatMap(manifest => manifest.routes).filter(route => route.class === 'unclassified').length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toContain('links');
  });
  it('does not infer this kernel belongs to the requested zone', async () => {
    vi.stubEnv('APP_URL', 'https://jin.other.test');
    const result = await deriveHostManifests('example.test', { kernelDirectory: directory() });
    expect(result.manifests[0].hostname).toBe('jin.other.test');
  });
  it('keeps truncated and invalid kernel specifications unclassified', async () => {
    state.truncated = true;
    let result = await deriveHostManifests('example.test', { kernelDirectory: directory() });
    expect(result.manifests[0].routes.some(route => route.reason.includes('truncated'))).toBe(true);
    state.truncated = false; state.content = 'paths: [';
    result = await deriveHostManifests('example.test', { kernelDirectory: directory() });
    expect(result.manifests[0].routes.some(route => route.reason.includes('parsed'))).toBe(true);
  });
});
