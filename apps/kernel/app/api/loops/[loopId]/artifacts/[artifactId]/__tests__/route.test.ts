import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAuthMock, getArtifactMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  getArtifactMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: (identity: { id: string; actingFor?: string }) => identity.actingFor ?? identity.id,
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/loops/artifact-store', () => ({ getLoopOutputArtifact: getArtifactMock }));

import { GET, OPTIONS } from '../route';

const principal = 'did:imajin:operator';
function read(loopId = 'loop_1', artifactId = 'sha256_abc') {
  const request = new Request('https://test.imajin.ai/api/loops/loop_1/artifacts/sha256_abc');
  return GET(request as Parameters<typeof GET>[0], { params: Promise.resolve({ loopId, artifactId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ identity: { id: principal } });
});

describe('GET /api/loops/:loopId/artifacts/:artifactId', () => {
  it('rejects unauthenticated requests before querying storage', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await read()).status).toBe(401);
    expect(getArtifactMock).not.toHaveBeenCalled();
  });

  it('uses the effective principal and loop, not a hash-only lookup', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: principal } });
    const artifact = { id: 'sha256_abc', sha256: 'abc', byteLength: 20000, mediaType: 'application/json', output: { kind: 'text', text: 'full output' } };
    getArtifactMock.mockResolvedValue(artifact);
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(artifact);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(getArtifactMock).toHaveBeenCalledWith('loop_1', principal, 'sha256_abc');
  });

  it.each(['absent', 'another principal', 'another loop'])('returns indistinguishable 404 for %s artifacts', async () => {
    getArtifactMock.mockResolvedValue(null);
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it.each([['', 'hash'], ['loop', ''], [' ', 'hash']])('rejects empty route identifiers', async (loopId, artifactId) => {
    expect((await read(loopId, artifactId)).status).toBe(400);
    expect(getArtifactMock).not.toHaveBeenCalled();
  });

  it('serves shared CORS preflight', async () => {
    const request = new Request('https://test.imajin.ai/api/loops/loop_1/artifacts/hash');
    expect((await OPTIONS(request as Parameters<typeof OPTIONS>[0])).status).toBe(204);
  });
});
