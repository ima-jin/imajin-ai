import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, OPTIONS } from '../route';
import { resolveReachDiscovery } from '@/src/lib/auth/reach-discovery';

vi.mock('@/src/lib/auth/reach-discovery', () => ({ resolveReachDiscovery: vi.fn() }));
const props = { params: Promise.resolve({ handle: '@ryan' }) };

beforeEach(() => {
  vi.mocked(resolveReachDiscovery).mockReset().mockResolvedValue({
    principalDid: 'did:imajin:ryan',
    url: 'https://node.test/.well-known/agent/did%3Aimajin%3Aryan',
    instructionsUrl: 'https://node.test/ryan/reach',
    onboarding: { endpoint: 'https://node.test/reach/ryan/knock' },
  } as Awaited<ReturnType<typeof resolveReachDiscovery>>);
});

describe('public reach-only onboarding document', () => {
  it('publishes the live knock contract with no owner registration or approval requirement', async () => {
    const response = await GET({} as Request, props);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(resolveReachDiscovery).toHaveBeenCalledWith('@ryan');
    expect(body.credential).toMatchObject({
      endpoint: 'https://node.test/reach/ryan/knock', method: 'POST', successStatus: 201,
      example: { onBehalfOf: { platform: 'YOUR_PLATFORM' } }, scope: 'agent:reach',
    });
    expect(body.credential.response).toContain('UNVERIFIED');
    expect(JSON.stringify(body)).not.toContain('/auth/api/knock');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('withholds onboarding when reach is disabled or unknown', async () => {
    vi.mocked(resolveReachDiscovery).mockResolvedValue(null);
    const response = await GET({} as Request, props);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Reach recipient not found' });
  });

  it('sanitizes infrastructure failures', async () => {
    vi.mocked(resolveReachDiscovery).mockRejectedValue(new Error('PRIVATE'));
    const response = await GET({} as Request, props);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE');
  });

  it('allows anonymous GET preflight without resolving the principal', () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(resolveReachDiscovery).not.toHaveBeenCalled();
  });
});
