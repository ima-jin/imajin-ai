import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as yamlSpec } from '../app/cloudflare/api/spec/route';
import { GET as catalogue } from '../app/registry/api/specs/route';
import { GET as jsonSpec } from '../app/registry/api/specs/[service]/route';

const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/src/lib/kernel/api-specs', () => ({ readApiSpec: state.read }));
vi.mock('@imajin/config', () => ({
  SERVICES: [], getService: () => undefined, corsHeaders: () => ({}),
  corsOptions: () => new Response(null), buildPublicUrl: () => '',
}));
afterEach(() => vi.clearAllMocks());
describe('Cloudflare spec routes', () => {
  it('appears in the registry catalogue', async () => {
    const response = catalogue(new NextRequest('https://fixture.invalid/registry/api/specs'));
    expect((await response.json()).services).toContainEqual(expect.objectContaining({
      name: 'cloudflare', spec: '/cloudflare/api/spec', category: 'kernel',
    }));
  });
  it('serves YAML and the registry JSON conversion from the same canonical reader', async () => {
    state.read.mockReturnValue({ content: 'openapi: "3.1.0"\ninfo:\n  title: Cloudflare\n' });
    expect(yamlSpec().headers.get('Content-Type')).toBe('text/yaml');
    expect(await yamlSpec().text()).toContain('Cloudflare');
    const response = await jsonSpec(new NextRequest('https://fixture.invalid'), { params: Promise.resolve({ service: 'cloudflare' }) });
    expect((await response.json()).info.title).toBe('Cloudflare');
    expect(state.read).toHaveBeenCalledWith('cloudflare');
  });
  it('fails closed if the canonical spec is absent', async () => {
    state.read.mockReturnValue(null);
    expect(await yamlSpec().text()).toBe('');
    const response = await jsonSpec(new NextRequest('https://fixture.invalid'), { params: Promise.resolve({ service: 'cloudflare' }) });
    expect(response.status).toBe(404);
  });
});
