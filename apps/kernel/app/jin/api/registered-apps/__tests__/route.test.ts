import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), operator: vi.fn(), isOperator: vi.fn(), list: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@/src/lib/notify/operator-approvals', () => ({
  getOperatorDid: mocks.operator, isOperatorIdentity: mocks.isOperator,
}));
vi.mock('@/src/lib/apps/registered-apps', () => ({ listRegisteredApps: mocks.list }));
import * as route from '../route';
const req = () => new Request('https://fixture.invalid/jin/api/registered-apps') as Parameters<typeof route.GET>[0];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ identity: { id: 'operator' } });
  mocks.operator.mockResolvedValue('operator');
  mocks.isOperator.mockReturnValue(true);
  mocks.list.mockResolvedValue([]);
});
describe('registered app read route', () => {
  it('requires authentication before any data read', async () => {
    mocks.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await route.GET(req())).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(['non-operator', 'missing-operator'])('refuses %s before reading registry history', async scenario => {
    if (scenario === 'non-operator') mocks.isOperator.mockReturnValue(false);
    else mocks.operator.mockResolvedValue(null);
    expect((await route.GET(req())).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('returns uncached metadata and exports no mutation handlers', async () => {
    const response = await route.GET(req());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ apps: [] });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(route).not.toHaveProperty(method);
  });
  it('redacts provider failures', async () => {
    mocks.list.mockRejectedValue(new Error('private provider detail'));
    const response = await route.GET(req());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Registered apps unavailable' });
  });
  it('documents the new GET route and read-only semantics in the /spec source', () => {
    const spec = parse(readFileSync(resolve('apps/kernel/api-spec/jin.yaml'), 'utf8'));
    const path = spec.paths['/jin/api/registered-apps'];
    expect(path.get.security).toEqual([{ cookieAuth: [] }, { bearerAuth: [] }]);
    expect(Object.keys(path)).toEqual(['get']);
    expect(path.get.servers.map((server: { url: string }) => server.url))
      .toEqual(['https://{node}.imajin.ai', 'http://localhost:3000']);
    expect(path.get.description).toContain('never writes registry rows');
  });
});
