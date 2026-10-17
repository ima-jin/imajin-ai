import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  gate: vi.fn(), prepare: vi.fn(), dispatch: vi.fn(),
  Error: class extends Error { constructor(message: string, public status = 400) { super(message); } },
}));
vi.mock('@/src/lib/jin/spend-route-gate', () => ({ gateOperator: mocks.gate }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@/src/lib/jin/session-commands', () => ({
  prepareSessionCommand: mocks.prepare, dispatchSessionCommand: mocks.dispatch, SessionCommandError: mocks.Error,
}));
import { POST } from '../route';
const params = { params: Promise.resolve({ loopId: 'loop' }) };
const valid = { action: 'prepare', type: 'session.send', payload: { loopId: 'loop', message: 'Hello' } };
function request(body: unknown, literal = false) {
  return new NextRequest('http://localhost/jin/api/runs/loop/commands', { method: 'POST', body: literal ? String(body) : JSON.stringify(body) });
}
beforeEach(() => {
  mocks.gate.mockResolvedValue({ operatorDid: 'did:imajin:principal' });
  mocks.prepare.mockResolvedValue({ commandId: 'id' });
  mocks.dispatch.mockResolvedValue({ commandId: 'id', delivered: false });
});
describe('run command route', () => {
  it('prepares and dispatches through explicit actions and returns transport only', async () => {
    let response = await POST(request(valid), params);
    expect(await response.json()).toEqual({ command: { commandId: 'id' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.prepare).toHaveBeenCalledWith('loop', 'did:imajin:principal', 'session.send', valid.payload);
    response = await POST(request({ action: 'dispatch', command: { commandId: 'id' } }), params);
    expect(await response.json()).toEqual({ commandId: 'id', delivered: false });
  });
  it('returns gate denial without invoking command service', async () => {
    mocks.gate.mockResolvedValue({ response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    const before = mocks.prepare.mock.calls.length;
    expect((await POST(request(valid), params)).status).toBe(401);
    expect(mocks.prepare.mock.calls.length).toBe(before);
  });
  it.each(['{', JSON.stringify({ ...valid, targetDid: 'did:imajin:attacker' }), JSON.stringify({ action: 'other' })])('rejects malformed/extra action data', async body => {
    expect((await POST(request(body, true), params)).status).toBe(400);
  });
  it('rejects oversized input and sanitizes internal errors', async () => {
    expect((await POST(request('x'.repeat(33_000), true), params)).status).toBe(413);
    mocks.prepare.mockRejectedValueOnce(new mocks.Error('Origin unavailable', 409));
    const denied = await POST(request(valid), params);
    expect(denied.status).toBe(409); expect(await denied.json()).toEqual({ error: 'Origin unavailable' });
    mocks.prepare.mockRejectedValueOnce(new Error('secret database parameters'));
    const unavailable = await POST(request(valid), params);
    expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ error: 'Command unavailable' });
  });
});
