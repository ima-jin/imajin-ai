import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), acting: vi.fn(), read: vi.fn(), update: vi.fn(), check: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth, resolveActingDid: mocks.acting }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/google/setup', () => ({ updateGoogleSetup: mocks.update }));
vi.mock('@/src/lib/google/setup-checks', () => ({
  readGoogleSetupView: mocks.read, checkSearchConsoleSetup: mocks.check,
}));

import { GET, PATCH, POST, OPTIONS } from '../route';

function request(method = 'GET', body?: unknown, slot = 'work') {
  return new NextRequest(`https://kernel.test/google/api/setup?slot=${encodeURIComponent(slot)}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:session' } });
  mocks.acting.mockReturnValue('did:imajin:org');
  mocks.read.mockResolvedValue({ version: 1, slot: 'work', businessProfileAvailable: false, steps: {} });
  mocks.update.mockResolvedValue({});
  mocks.check.mockResolvedValue({ status: 'passed', checkedAt: '2026-10-17T00:00:00Z', message: 'Search Console only' });
});

describe('Google setup owner route', () => {
  it('reads the session acting identity and selected slot, with no-store and CORS', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith('did:imajin:org', 'work');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.test');
  });

  it('defaults missing slot to primary and handles preflight', async () => {
    await GET(new NextRequest('https://kernel.test/google/api/setup'));
    expect(mocks.read).toHaveBeenCalledWith('did:imajin:org', 'primary');
    expect(OPTIONS(request()).status).toBe(204);
  });

  it.each([GET, PATCH, POST])('rejects app-only or unauthenticated requests before metadata access', async (handler) => {
    mocks.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await handler(request('POST'))).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('stores only a validated step update scoped to the authenticated identity', async () => {
    const body = { step: 'business-access', status: 'pending_google', caseUrl: 'https://support.google.com/business/thread/123' };
    expect((await PATCH(request('PATCH', body))).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('did:imajin:org', 'work', body.step, body.status, body.caseUrl);
  });

  it.each([
    { step: 'unknown', status: 'approved' },
    { step: 'project', status: 'unknown' },
    { step: '__proto__', status: 'approved' },
    { step: 'project', status: '__proto__' },
    { step: 'project', status: 'approved', ownerDid: 'did:imajin:other' },
    { step: 'vault', status: 'approved', clientSecret: 'not-accepted' },
    { step: 'business-access', status: 'submitted', caseUrl: 'https://attacker.test/case' },
    { step: 'business-access', status: 'submitted', caseUrl: 'javascript:alert(1)' },
    { step: 'business-access', status: 'submitted', caseUrl: 'https://user:pass@support.google.com/case' },
    { step: 'project', status: 'approved', caseUrl: 'https://support.google.com/case' },
  ])('rejects unknown/credential/foreign-owner fields and unsafe case links: %j', async (body) => {
    expect((await PATCH(request('PATCH', body))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and invalid slot without side effects', async () => {
    const broken = new NextRequest('https://kernel.test/google/api/setup', { method: 'PATCH', body: '{' });
    expect((await PATCH(broken)).status).toBe(400);
    expect((await GET(request('GET', undefined, '../work'))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('checks Search Console independently without updating any admin approval', async () => {
    const response = await POST(request('POST'));
    expect(await response.json()).toMatchObject({ businessProfileAvailable: false, checks: { searchConsole: { status: 'passed' } } });
    expect(mocks.check).toHaveBeenCalledWith('did:imajin:org', 'work');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('sanitizes storage/provider failures instead of returning exception text', async () => {
    mocks.read.mockRejectedValue(new Error('private database details'));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private');
  });
});
