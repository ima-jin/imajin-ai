import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { sendOwnSessionCommand, handleSessionCommandRequest, isSessionEvent, forwardSessionEvent } = require('../session-commands');
const agent = 'did:imajin:agent';
const principal = 'did:imajin:principal';
const frame = { type: 'session.send', to: agent, payload: { loopId: 'loop', message: 'private task' } };
function socket(readyState = 1) { return { readyState, send: vi.fn() }; }

beforeEach(() => {
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'inert-fixture');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ accepted: true })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('session commands own-DID transport', () => {
  it('sends to exactly one own authenticated socket, never delegates/principal/subscriptions', () => {
    const own = socket(); const duplicate = socket(); const delegate = socket(); const owner = socket();
    const didSockets = new Map([[agent, new Set([delegate, owner, own, duplicate])]]);
    const meta = new Map([
      [own, { did: agent, authenticated: true }], [duplicate, { did: agent, authenticated: true }],
      [delegate, { did: 'did:imajin:delegate', authenticated: true, alsoDids: new Set([agent]) }],
      [owner, { did: principal, authenticated: true, subscriptions: new Set([agent]) }],
    ]);
    expect(sendOwnSessionCommand(didSockets, meta, agent, frame)).toBe(true);
    expect(own.send).toHaveBeenCalledOnce();
    expect(own.send).toHaveBeenCalledWith(JSON.stringify(frame));
    for (const candidate of [delegate, owner, duplicate]) expect(candidate.send).not.toHaveBeenCalled();
  });
  it('returns false for no sockets, closed or unauthenticated own sockets, unsupported frames and mismatches', () => {
    const closed = socket(3); const pending = socket();
    const own = new Map([[agent, new Set([closed, pending])]]);
    const meta = new Map([[closed, { did: agent, authenticated: true }], [pending, { did: agent, authenticated: false }]]);
    expect(sendOwnSessionCommand(new Map(), meta, agent, frame)).toBe(false);
    expect(sendOwnSessionCommand(own, meta, agent, frame)).toBe(false);
    expect(sendOwnSessionCommand(own, meta, agent, null)).toBe(false);
    expect(sendOwnSessionCommand(own, meta, principal, frame)).toBe(false);
    expect(sendOwnSessionCommand(own, meta, agent, { ...frame, type: 'notification' })).toBe(false);
    expect(sendOwnSessionCommand(own, new Map(), agent, frame)).toBe(false);
  });
  it('handles synchronous dead socket failure without reporting false delivery', () => {
    const broken = socket(); broken.send.mockImplementation(() => { throw new Error('closed'); });
    const other = socket();
    const own = new Map([[agent, new Set([broken, other])]]);
    const meta = new Map([[broken, { did: agent, authenticated: true }], [other, { did: agent, authenticated: true }]]);
    expect(sendOwnSessionCommand(own, meta, agent, frame)).toBe(true);
    expect(other.send).toHaveBeenCalledOnce();
  });
  it.each([
    ['missing-key', '', 'inert-fixture', '{}', 401],
    ['wrong-key', 'inert-fixture', 'wrong', '{}', 401],
    ['malformed', 'inert-fixture', 'inert-fixture', '{', 400],
    ['mismatch', 'inert-fixture', 'inert-fixture', JSON.stringify({ targetDid: principal, command: frame }), 400],
    ['empty', 'inert-fixture', 'inert-fixture', '{}', 400],
    ['large', 'inert-fixture', 'inert-fixture', 'x'.repeat(33_000), 413],
    ['offline', 'inert-fixture', 'inert-fixture', JSON.stringify({ targetDid: agent, command: frame }), 200],
  ])('guards internal push %s', (_name, key, provided, body, status) => {
    const req = Object.assign(new EventEmitter(), { headers: { 'x-internal-key': provided } });
    const res = { writeHead: vi.fn(), end: vi.fn() };
    handleSessionCommandRequest(req, res, new Map(), new Map(), key);
    req.emit('data', body); req.emit('data', ''); req.emit('end');
    expect(res.writeHead).toHaveBeenCalledWith(status, { 'Content-Type': 'application/json' });
    if (status === 200) expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ delivered: false });
  });
  it('forwards only typed outcomes and bindings with authenticated meta.did, not frame did', async () => {
    const binding = { type: 'loop.approval.bound', did: principal, attestation: { from: agent } };
    await forwardSessionEvent({ authenticated: true, did: agent }, binding);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ socketDid: agent, frame: binding });
    expect(isSessionEvent('loop.session.spawn.completed')).toBe(true);
    expect(isSessionEvent('loop.session.approve.failed')).toBe(true);
    expect(isSessionEvent('loop.session.other.completed')).toBe(false);
    expect(isSessionEvent('loop.started')).toBe(false);
  });
  it('does not forward unauthenticated, oversized or unrecognized frames, and swallows network errors', async () => {
    const valid = { type: 'loop.session.send.failed' };
    await forwardSessionEvent({ authenticated: false, did: agent }, valid);
    await forwardSessionEvent({ authenticated: true, did: '' }, valid);
    await forwardSessionEvent({ authenticated: true, did: agent }, { type: 'unknown' });
    await forwardSessionEvent({ authenticated: true, did: agent }, { ...valid, body: 'x'.repeat(25_000) });
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockRejectedValue(new Error('secret provider error'));
    await expect(forwardSessionEvent({ authenticated: true, did: agent }, valid)).resolves.toBeUndefined();
    vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
    await forwardSessionEvent({ authenticated: true, did: agent }, valid);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
