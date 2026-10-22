import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), report: vi.fn() }));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: mocks.auth }));
vi.mock('@/src/lib/notify/approval-expiry', () => ({ reportApprovalSourceState: mocks.report }));
import { POST } from '../route';
const request = (body: unknown) => new NextRequest('http://localhost/notify/api/internal/operator-approvals/state', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue(null); mocks.report.mockResolvedValue(true); });
describe('authenticated source truth', () => {
  it.each(['gone', 'superseded'])('records %s without an operator decision', async state => {
    const response = await POST(request({ proposalId: 'test', state }));
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.report).toHaveBeenCalledWith('test', state);
  });
  it.each([401, 403, 503])('rejects missing/wrong/unavailable internal authority (%s)', async status => {
    mocks.auth.mockResolvedValue(new Response(null, { status }));
    expect((await POST(request({ proposalId: 'test', state: 'gone' }))).status).toBe(status);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { state: 'gone' }, { proposalId: '', state: 'gone' }, { proposalId: ' ', state: 'gone' },
    { proposalId: 3, state: 'gone' }, { proposalId: 'test' }, { proposalId: 'test', state: ['gone'] },
    { proposalId: 'test', state: 'approved' }, { proposalId: 'test', state: 'gone', operatorDid: 'foreign' },
  ])('refuses invalid source-state body %j before mutation', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON', async () => {
    const malformed = new NextRequest('http://localhost', { method: 'POST', body: '{' });
    expect((await POST(malformed)).status).toBe(400);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it('does not silently succeed for a missing or terminal proposal', async () => {
    mocks.report.mockResolvedValue(false);
    expect((await POST(request({ proposalId: 'missing', state: 'gone' }))).status).toBe(409);
  });
  it('sanitizes signing/persistence errors', async () => {
    mocks.report.mockRejectedValue(new Error('private detail'));
    const response = await POST(request({ proposalId: 'test', state: 'gone' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unable to record source state' });
  });
});
