import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createPrivateNotifications, isPrivateReachNotification, isPrivateReachFrame } = require('../private-notifications');
const { createAlsoRegistry } = require('../also-registry');

const AGENT = 'did:imajin:agent';
const PRINCIPAL = 'did:imajin:principal';
const OTHER = 'did:imajin:other';

function frame(id = 'ntf_private', scope = 'agent.reach.delivered') {
  return {
    type: 'notification', id, scope, title: 'Reach', body: 'New message',
    data: {
      eventType: scope, issuer: AGENT, subject: PRINCIPAL,
      message: 'Original private content', signature: { alg: 'ed25519', sig: 'public-test-signature' },
      nested: { whitespace: '  unchanged\n', unverifiedClaim: true },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const ws = { readyState: 1, send: vi.fn() };
  const meta = { did: AGENT, authenticated: true, alsoDids: new Set<string>() };
  const metas = new Map([[ws, meta]]);
  const registry = createAlsoRegistry({ verifyDelegation: vi.fn().mockResolvedValue(true) });
  const verifyDelegation = vi.fn().mockResolvedValue(true);
  const fetchBacklog = vi.fn().mockResolvedValue({ frames: [frame()], truncated: false });
  const ack = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const rail = createPrivateNotifications({
    getMeta: (socket: typeof ws) => metas.get(socket), registry, verifyDelegation, fetchBacklog, ack, log,
  });
  const register = () => registry.handle(ws, meta, { type: 'register_also', did: PRINCIPAL });
  const unregister = () => registry.handle(ws, meta, { type: 'unregister_also', did: PRINCIPAL });
  return { ws, meta, metas, registry, verifyDelegation, fetchBacklog, ack, log, rail, register, unregister };
}

let f: ReturnType<typeof fixture>;
beforeEach(async () => {
  f = fixture();
  await f.register();
});

describe('private principal notification rail', () => {
  it.each(['agent.reach.delivered', 'agent.reach.replied'])('recognizes %s by scope or original event type', (scope) => {
    expect(isPrivateReachNotification(frame('id', scope))).toBe(true);
    expect(isPrivateReachNotification({ ...frame('id', scope), scope: 'unknown' })).toBe(true);
    expect(isPrivateReachNotification({ type: 'event', scope })).toBe(false);
    expect(isPrivateReachNotification(null)).toBe(false);
    expect(isPrivateReachNotification(frame('id', 'warp.run.completed'))).toBe(false);
    expect(isPrivateReachFrame({ type: 'bus_event', eventType: scope })).toBe(true);
    expect(isPrivateReachFrame({ type: 'bus_event', eventType: 'message.send' })).toBe(false);
    expect(isPrivateReachFrame(frame('id', scope))).toBe(true);
  });

  it('sends the exact original envelope without verifying, adding or replacing its signature', async () => {
    const original = frame();
    const bytes = JSON.stringify(original);
    expect(await f.rail.send(f.ws, PRINCIPAL, original)).toBe(true);
    expect(f.verifyDelegation).toHaveBeenCalledWith(AGENT, PRINCIPAL);
    expect(f.ws.send).toHaveBeenCalledWith(bytes);
    expect(JSON.stringify(original)).toBe(bytes);
    delete (original.data as Partial<typeof original.data>).signature;
    expect(await f.rail.send(f.ws, PRINCIPAL, original)).toBe(true);
    expect(JSON.parse(f.ws.send.mock.calls[1][0]).data.signature).toBeUndefined();
  });

  it('lets the principal receive its own notification without delegation', async () => {
    f.meta.did = PRINCIPAL;
    f.meta.alsoDids.clear();
    expect(await f.rail.send(f.ws, PRINCIPAL, frame())).toBe(true);
    expect(f.verifyDelegation).not.toHaveBeenCalled();
  });

  it('conservatively cancels pending work for arbitrary unregisters without per-DID generation state', async () => {
    const pending = deferred<boolean>();
    f.verifyDelegation.mockReturnValueOnce(pending.promise);
    const work = f.rail.send(f.ws, PRINCIPAL, frame());
    for (let index = 0; index < 500; index++) {
      await f.registry.handle(f.ws, f.meta, { type: 'unregister_also', did: `did:imajin:unrelated-${index}` });
    }
    expect(f.registry.versionFor(f.ws)).toBe(500);
    expect(f.meta.alsoDids.size).toBe(1);
    pending.resolve(true);
    expect(await work).toBe(false);
    expect(f.ws.send).not.toHaveBeenCalled();
  });

  it.each([false, undefined, 'yes'])('denies any non-true authority result: %s', async (allowed) => {
    f.verifyDelegation.mockResolvedValue(allowed);
    expect(await f.rail.send(f.ws, PRINCIPAL, frame())).toBe(false);
    await f.rail.replay(f.ws, PRINCIPAL);
    expect(f.ws.send).not.toHaveBeenCalled();
    expect(f.fetchBacklog).not.toHaveBeenCalled();
  });

  it('fails closed on authorization failure and refuses unregistered or unauthenticated sockets', async () => {
    f.verifyDelegation.mockRejectedValue(new Error('lookup unavailable'));
    expect(await f.rail.send(f.ws, PRINCIPAL, frame())).toBe(false);
    expect(await f.rail.send(f.ws, OTHER, frame())).toBe(false);
    f.meta.authenticated = false;
    expect(await f.rail.send(f.ws, PRINCIPAL, frame())).toBe(false);
    expect(f.ws.send).not.toHaveBeenCalled();
  });

  it('rechecks authority for every replayed frame, stopping on revocation after the first', async () => {
    f.fetchBacklog.mockResolvedValue({ frames: [frame('one'), frame('two')] });
    f.verifyDelegation.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    await f.rail.replay(f.ws, PRINCIPAL);
    expect(f.fetchBacklog).toHaveBeenCalledWith(PRINCIPAL, true);
    expect(f.ws.send).toHaveBeenCalledTimes(1);
    expect(f.verifyDelegation).toHaveBeenCalledTimes(3);
  });

  it('never replays unrelated notifications and preserves signed and unsigned data', async () => {
    const unsigned = { ...frame('unsigned'), data: { eventType: 'agent.reach.replied', message: 'unsigned claim' } };
    const frames = [frame('one'), frame('unrelated', 'warp.run.completed'), unsigned];
    f.fetchBacklog.mockResolvedValue({ frames });
    await f.rail.replay(f.ws, PRINCIPAL);
    expect(f.ws.send.mock.calls.map(([bytes]) => JSON.parse(bytes))).toEqual([frames[0], unsigned]);
  });

  it.each(['send', 'ack', 'replay'])('stops %s after an unregister/re-register during authorization', async (operation) => {
    f.rail.observe(f.ws, PRINCIPAL, frame());
    const pending = deferred<boolean>();
    f.verifyDelegation.mockReturnValueOnce(pending.promise);
    let work: Promise<unknown>;
    if (operation === 'send') work = f.rail.send(f.ws, PRINCIPAL, frame());
    else if (operation === 'ack') work = f.rail.acknowledge(f.ws, 'ntf_private');
    else work = f.rail.replay(f.ws, PRINCIPAL);
    await f.unregister();
    await f.register();
    pending.resolve(true);
    await work;
    expect(f.ws.send).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.fetchBacklog).not.toHaveBeenCalled();
  });

  it.each(['send', 'ack', 'replay'])('stops %s after socket cleanup during authorization', async (operation) => {
    f.rail.observe(f.ws, PRINCIPAL, frame());
    const pending = deferred<boolean>();
    f.verifyDelegation.mockReturnValueOnce(pending.promise);
    let work: Promise<unknown>;
    if (operation === 'send') work = f.rail.send(f.ws, PRINCIPAL, frame());
    else if (operation === 'ack') work = f.rail.acknowledge(f.ws, 'ntf_private');
    else work = f.rail.replay(f.ws, PRINCIPAL);
    f.metas.delete(f.ws);
    f.registry.cleanup(f.ws, f.meta);
    f.rail.cleanup(f.ws);
    pending.resolve(true);
    await work;
    expect(f.ws.send).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('stops replay when unregister happens while backlog lookup is pending', async () => {
    const pending = deferred<{ frames: ReturnType<typeof frame>[] }>();
    f.fetchBacklog.mockReturnValue(pending.promise);
    const work = f.rail.replay(f.ws, PRINCIPAL);
    await vi.waitFor(() => expect(f.fetchBacklog).toHaveBeenCalled());
    await f.unregister();
    await f.register();
    pending.resolve({ frames: [frame()] });
    await work;
    expect(f.ws.send).not.toHaveBeenCalled();
  });

  it('ACKs only a server-observed principal binding, with fresh delegation checks', async () => {
    await f.rail.send(f.ws, PRINCIPAL, frame());
    f.verifyDelegation.mockClear();
    await f.rail.acknowledge(f.ws, 'ntf_private');
    expect(f.verifyDelegation).toHaveBeenCalledWith(AGENT, PRINCIPAL);
    expect(f.ack).toHaveBeenCalledWith('ntf_private', PRINCIPAL);
    f.ack.mockClear();
    f.verifyDelegation.mockResolvedValue(false);
    await f.rail.acknowledge(f.ws, 'ntf_private');
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('cannot ACK a principal id it has not observed, including a cleared binding', async () => {
    await f.rail.acknowledge(f.ws, 'unobserved');
    expect(f.ack).toHaveBeenLastCalledWith('unobserved', AGENT);
    f.rail.observe(f.ws, PRINCIPAL, frame());
    f.rail.cleanup(f.ws);
    await f.rail.acknowledge(f.ws, 'ntf_private');
    expect(f.ack).toHaveBeenLastCalledWith('ntf_private', AGENT);
    await f.rail.acknowledge(f.ws, '');
    await f.rail.acknowledge(f.ws, null);
    expect(f.ack).toHaveBeenCalledTimes(2);
  });

  it('bounds observed ids and never uses a nonprivate delegated binding to select a principal', async () => {
    for (let index = 0; index < 1001; index++) f.rail.observe(f.ws, PRINCIPAL, frame(`id_${index}`));
    await f.rail.acknowledge(f.ws, 'id_0');
    expect(f.ack).toHaveBeenLastCalledWith('id_0', AGENT);
    await f.rail.acknowledge(f.ws, 'id_1000');
    expect(f.ack).toHaveBeenLastCalledWith('id_1000', PRINCIPAL);
    f.rail.observe(f.ws, PRINCIPAL, frame('unrelated', 'warp.run.completed'));
    await f.rail.acknowledge(f.ws, 'unrelated');
    expect(f.ack).toHaveBeenLastCalledWith('unrelated', AGENT);
  });

  it('swallows failed backlog fetches and socket writes', async () => {
    f.fetchBacklog.mockRejectedValue(new Error('failed'));
    await expect(f.rail.replay(f.ws, PRINCIPAL)).resolves.toBeUndefined();
    f.ws.send.mockImplementation(() => { throw new Error('closed'); });
    expect(await f.rail.send(f.ws, PRINCIPAL, frame())).toBe(false);
    expect(f.log).toHaveBeenCalledTimes(2);
  });
});
