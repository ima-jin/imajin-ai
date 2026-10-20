import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  rows: [] as Record<string, unknown>[],
  apps: [] as Record<string, unknown>[],
}));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: h.auth }));
vi.mock('@/src/db', () => {
  const registryApps = {};
  const from = (table: unknown) => ({ where: () => {
    const rows = table === registryApps ? h.apps : h.rows;
    return Object.assign(Promise.resolve(rows), { limit: async () => rows });
  } });
  return { attestations: {}, registryApps, db: { select: () => ({ from }) } };
});
import { POST } from '../route';
function request(body: unknown = { appDid: 'app', attestationId: 'grant' }) {
  return new NextRequest('https://example.com/auth/api/apps/validate', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  h.auth.mockResolvedValue(null);
  h.apps = [{ visibility: 'public' }];
  h.rows = [{ issuerDid: 'person', revokedAt: null, expiresAt: null, payload: { scopes: ['profile:read'] } }];
});
describe('app authorization validation', () => {
  it('rejects invalid internal credentials before reading grants', async () => {
    h.auth.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await POST(request())).status).toBe(401);
  });
  it('rejects invalid JSON', async () => {
    expect((await POST(new NextRequest('https://example.com', { method: 'POST', body: '{' }))).status).toBe(400);
  });
  it.each([{ attestationId: 'grant' }, { appDid: 'app' }, { appDid: 1, attestationId: 'grant' }])('requires identifiers', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
  });
  it('returns not found for missing grants', async () => {
    h.rows = [];
    expect((await POST(request())).status).toBe(404);
  });
  it('refuses grants whose app registration is missing', async () => {
    h.apps = [];
    expect((await POST(request())).status).toBe(403);
  });
  it('rejects revoked grants', async () => {
    h.rows[0].revokedAt = new Date();
    expect((await POST(request())).status).toBe(403);
  });
  it.each([new Date(0), new Date(Date.now())])('rejects expired grants', async (expiresAt) => {
    h.rows[0].expiresAt = expiresAt;
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Authorization has expired' });
  });
  it('rejects scopes that were not granted', async () => {
    expect((await POST(request({ appDid: 'app', attestationId: 'grant', scope: 'write' }))).status).toBe(403);
  });
  it('accepts live granted scopes', async () => {
    h.rows[0].expiresAt = new Date(Date.now() + 60_000);
    const response = await POST(request({ appDid: 'app', attestationId: 'grant', scope: 'profile:read' }));
    expect(await response.json()).toEqual({
      appDid: 'app', userDid: 'person', scopes: ['profile:read'], attestationId: 'grant',
    });
  });
  it('accepts indefinite empty grants without a requested scope', async () => {
    h.rows[0].payload = null;
    expect((await POST(request())).status).toBe(200);
  });
});
