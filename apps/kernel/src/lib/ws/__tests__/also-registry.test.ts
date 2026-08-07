/**
 * Tests for the `register_also` delegation registry (#1653).
 *
 * The registry decides which sockets receive a DID's notification frames, so the
 * cases that matter are the ones where it must refuse: an unverified delegation,
 * a socket asking for more DIDs than the cap allows, and a socket that closed
 * while its authorization check was still out. The other half of the contract is
 * that delegate sockets stay out of ws-server's `didSockets`, which is what
 * presence is counted from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ws-server.js and everything it loads is plain CJS, outside the Next build.
const { createAlsoRegistry, MAX_ALSO_DIDS } = require('../also-registry');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT = 'did:imajin:jin';
const PRINCIPAL = 'did:imajin:ryan';
const OTHER = 'did:imajin:someone-else';

type Frame = { type: string; did?: string; message?: string } | null;
type Meta = { did: string | null; alsoDids: Set<string> };
type Socket = { id: string; readyState: number };

interface Registry {
  handle(ws: Socket, meta: Meta, msg: { type: string; did?: unknown }): Promise<Frame>;
  cleanup(ws: Socket, meta: Meta): void;
  recipientsFor(did: string, ownSockets?: Set<Socket>): Set<Socket> | undefined;
  maxAlsoDids: number;
}

let verifyDelegation: ReturnType<typeof vi.fn>;

function makeRegistry(overrides: Record<string, unknown> = {}): Registry {
  return createAlsoRegistry({ verifyDelegation, ...overrides }) as Registry;
}

function makeSocket(id = 'ws-1'): Socket {
  return { id, readyState: 1 };
}

function makeMeta(did: string | null = AGENT): Meta {
  return { did, alsoDids: new Set<string>() };
}

function register(registry: Registry, ws: Socket, meta: Meta, did: unknown) {
  return registry.handle(ws, meta, { type: 'register_also', did });
}

function unregister(registry: Registry, ws: Socket, meta: Meta, did: unknown) {
  return registry.handle(ws, meta, { type: 'unregister_also', did });
}

beforeEach(() => {
  verifyDelegation = vi.fn().mockResolvedValue(true);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('register_also — self registration', () => {
  it('acks the socket\u2019s own DID without touching the delegate index', async () => {
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();

    const frame = await register(registry, ws, meta, AGENT);

    expect(frame).toEqual({ type: 'registered_also', did: AGENT });
    // A self-registration that landed in the delegate index would double-count
    // the socket in `sendToDid`, delivering every frame twice.
    expect(registry.recipientsFor(AGENT)).toBeUndefined();
    expect(meta.alsoDids.size).toBe(0);
    expect(verifyDelegation).not.toHaveBeenCalled();
  });
});

describe('register_also — authorization', () => {
  it('registers the socket once the delegation verifies', async () => {
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();

    const frame = await register(registry, ws, meta, PRINCIPAL);

    expect(frame).toEqual({ type: 'registered_also', did: PRINCIPAL });
    expect(verifyDelegation).toHaveBeenCalledWith(AGENT, PRINCIPAL);
    expect(meta.alsoDids.has(PRINCIPAL)).toBe(true);
    expect([...registry.recipientsFor(PRINCIPAL)!]).toEqual([ws]);
  });

  it('refuses and registers nothing when the delegation is denied', async () => {
    verifyDelegation.mockResolvedValue(false);
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();

    const frame = await register(registry, ws, meta, PRINCIPAL);

    expect(frame).toEqual({
      type: 'error',
      message: 'Not authorized to register for this DID',
    });
    expect(meta.alsoDids.size).toBe(0);
    expect(registry.recipientsFor(PRINCIPAL)).toBeUndefined();
  });

  it.each([
    ['a non-boolean truthy value', 'yes'],
    ['undefined', undefined],
    ['null', null],
  ])('treats %s from the verifier as a denial', async (_label, verdict) => {
    verifyDelegation.mockResolvedValue(verdict);
    const registry = makeRegistry();
    const meta = makeMeta();

    const frame = await register(registry, makeSocket(), meta, PRINCIPAL);

    expect(frame).toMatchObject({ type: 'error' });
    expect(meta.alsoDids.size).toBe(0);
  });

  it('denies when the verifier throws', async () => {
    verifyDelegation.mockRejectedValue(new Error('kernel unreachable'));
    const registry = makeRegistry();
    const meta = makeMeta();

    const frame = await register(registry, makeSocket(), meta, PRINCIPAL);

    expect(frame).toMatchObject({ type: 'error' });
    expect(registry.recipientsFor(PRINCIPAL)).toBeUndefined();
  });

  it('refuses an unauthenticated socket before calling the verifier', async () => {
    const registry = makeRegistry();

    const frame = await register(registry, makeSocket(), makeMeta(null), PRINCIPAL);

    expect(frame).toEqual({ type: 'error', message: 'Not authenticated' });
    expect(verifyDelegation).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing DID', undefined],
    ['an empty DID', ''],
    ['a non-string DID', { did: PRINCIPAL }],
  ])('rejects %s with an error frame rather than silence', async (_label, did) => {
    const registry = makeRegistry();

    const frame = await register(registry, makeSocket(), makeMeta(), did);

    expect(frame).toEqual({ type: 'error', message: 'register_also requires a DID' });
    expect(verifyDelegation).not.toHaveBeenCalled();
  });

  it('acks a repeat registration without re-verifying', async () => {
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();
    await register(registry, ws, meta, PRINCIPAL);

    const frame = await register(registry, ws, meta, PRINCIPAL);

    expect(frame).toEqual({ type: 'registered_also', did: PRINCIPAL });
    expect(verifyDelegation).toHaveBeenCalledTimes(1);
    expect([...registry.recipientsFor(PRINCIPAL)!]).toEqual([ws]);
  });
});

describe('register_also — cap', () => {
  it('defaults to five registrations per socket', () => {
    expect(MAX_ALSO_DIDS).toBe(5);
    expect(makeRegistry().maxAlsoDids).toBe(5);
  });

  it('refuses the registration past the cap', async () => {
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();

    for (let i = 0; i < MAX_ALSO_DIDS; i++) {
      const frame = await register(registry, ws, meta, `did:imajin:principal-${i}`);
      expect(frame).toMatchObject({ type: 'registered_also' });
    }

    const overflow = await register(registry, ws, meta, 'did:imajin:one-too-many');

    expect(overflow).toEqual({
      type: 'error',
      message: 'Too many register_also registrations',
    });
    expect(meta.alsoDids.size).toBe(MAX_ALSO_DIDS);
  });

  it('counts in-flight checks against the cap', async () => {
    // Frames arriving in a single TCP read all start before any await settles,
    // so a cap that only counted committed registrations would let a socket
    // hold an unbounded number of delegations at once.
    let release: (allowed: boolean) => void = () => {};
    verifyDelegation.mockImplementation(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    const registry = makeRegistry({ maxAlsoDids: 1 });
    const ws = makeSocket();
    const meta = makeMeta();

    const first = register(registry, ws, meta, PRINCIPAL);
    const second = await register(registry, ws, meta, OTHER);

    expect(second).toMatchObject({ message: 'Too many register_also registrations' });

    release(true);
    expect(await first).toMatchObject({ type: 'registered_also', did: PRINCIPAL });
  });

  it('rejects a duplicate request for a DID already being verified', async () => {
    let release: (allowed: boolean) => void = () => {};
    verifyDelegation.mockImplementation(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();

    const first = register(registry, ws, meta, PRINCIPAL);
    const duplicate = await register(registry, ws, meta, PRINCIPAL);

    expect(duplicate).toMatchObject({
      message: 'register_also already in flight for this DID',
    });

    release(true);
    await first;
  });

  it('frees the slot again when a check is denied', async () => {
    verifyDelegation.mockResolvedValueOnce(false).mockResolvedValue(true);
    const registry = makeRegistry({ maxAlsoDids: 1 });
    const ws = makeSocket();
    const meta = makeMeta();

    await register(registry, ws, meta, OTHER);
    const retry = await register(registry, ws, meta, PRINCIPAL);

    expect(retry).toMatchObject({ type: 'registered_also', did: PRINCIPAL });
  });
});

describe('unregister_also', () => {
  it('drops the delegation without dropping the connection', async () => {
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();
    await register(registry, ws, meta, PRINCIPAL);

    const frame = await unregister(registry, ws, meta, PRINCIPAL);

    expect(frame).toEqual({ type: 'unregistered_also', did: PRINCIPAL });
    expect(meta.alsoDids.size).toBe(0);
    expect(registry.recipientsFor(PRINCIPAL)).toBeUndefined();
  });

  it('is a harmless ack for a DID that was never registered', async () => {
    const registry = makeRegistry();

    const frame = await unregister(registry, makeSocket(), makeMeta(), PRINCIPAL);

    expect(frame).toEqual({ type: 'unregistered_also', did: PRINCIPAL });
  });

  it('rejects a missing DID', async () => {
    const registry = makeRegistry();

    const frame = await unregister(registry, makeSocket(), makeMeta(), undefined);

    expect(frame).toEqual({ type: 'error', message: 'unregister_also requires a DID' });
  });

  it('leaves a sibling socket registered for the same principal', async () => {
    const registry = makeRegistry();
    const first = makeSocket('ws-1');
    const second = makeSocket('ws-2');
    const firstMeta = makeMeta();
    const secondMeta = makeMeta('did:imajin:other-agent');
    await register(registry, first, firstMeta, PRINCIPAL);
    await register(registry, second, secondMeta, PRINCIPAL);

    await unregister(registry, first, firstMeta, PRINCIPAL);

    expect([...registry.recipientsFor(PRINCIPAL)!]).toEqual([second]);
  });
});

describe('cleanup on close', () => {
  it('removes the socket from every DID it was delegated for', async () => {
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();
    await register(registry, ws, meta, PRINCIPAL);
    await register(registry, ws, meta, OTHER);

    registry.cleanup(ws, meta);

    expect(registry.recipientsFor(PRINCIPAL)).toBeUndefined();
    expect(registry.recipientsFor(OTHER)).toBeUndefined();
    expect(meta.alsoDids.size).toBe(0);
  });

  it('leaves other sockets registered for the same DID', async () => {
    const registry = makeRegistry();
    const closing = makeSocket('ws-closing');
    const staying = makeSocket('ws-staying');
    const closingMeta = makeMeta();
    const stayingMeta = makeMeta('did:imajin:other-agent');
    await register(registry, closing, closingMeta, PRINCIPAL);
    await register(registry, staying, stayingMeta, PRINCIPAL);

    registry.cleanup(closing, closingMeta);

    expect([...registry.recipientsFor(PRINCIPAL)!]).toEqual([staying]);
  });

  it('tolerates a socket that never registered anything', () => {
    const registry = makeRegistry();

    expect(() => registry.cleanup(makeSocket(), makeMeta())).not.toThrow();
  });

  it('does not register a socket that closed mid-verification', async () => {
    // The close handler has already run by then, so a late attach would leave a
    // dead socket in the index for the lifetime of the process.
    let release: (allowed: boolean) => void = () => {};
    verifyDelegation.mockImplementation(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    const registry = makeRegistry();
    const ws = makeSocket();
    const meta = makeMeta();

    const pending = register(registry, ws, meta, PRINCIPAL);
    registry.cleanup(ws, meta);
    release(true);

    expect(await pending).toBeNull();
    expect(registry.recipientsFor(PRINCIPAL)).toBeUndefined();
  });
});

describe('recipientsFor', () => {
  it('returns the DID\u2019s own sockets untouched when there are no delegates', () => {
    const registry = makeRegistry();
    const own = new Set([makeSocket('own')]);

    expect(registry.recipientsFor(PRINCIPAL, own)).toBe(own);
  });

  it('returns undefined when nobody is listening', () => {
    expect(makeRegistry().recipientsFor(PRINCIPAL, undefined)).toBeUndefined();
  });

  it('returns delegates alone when the principal has no socket of their own', async () => {
    const registry = makeRegistry();
    const delegate = makeSocket('delegate');
    await register(registry, delegate, makeMeta(), PRINCIPAL);

    expect([...registry.recipientsFor(PRINCIPAL, undefined)!]).toEqual([delegate]);
  });

  it('unions the principal\u2019s own sockets with their delegates', async () => {
    const registry = makeRegistry();
    const delegate = makeSocket('delegate');
    const ownSocket = makeSocket('own');
    await register(registry, delegate, makeMeta(), PRINCIPAL);

    const recipients = registry.recipientsFor(PRINCIPAL, new Set([ownSocket]))!;

    expect([...recipients]).toEqual([ownSocket, delegate]);
  });

  it('keeps delegations from leaking to other DIDs', async () => {
    const registry = makeRegistry();
    await register(registry, makeSocket(), makeMeta(), PRINCIPAL);

    expect(registry.recipientsFor(OTHER)).toBeUndefined();
  });
});

describe('handle', () => {
  it('ignores message types it does not own', async () => {
    const registry = makeRegistry();

    expect(await registry.handle(makeSocket(), makeMeta(), { type: 'ping' })).toBeNull();
  });

  it('reports through the injected logger', async () => {
    verifyDelegation.mockResolvedValue(false);
    const log = vi.fn();
    const registry = makeRegistry({ log });

    await register(registry, makeSocket(), makeMeta(), PRINCIPAL);

    expect(log).toHaveBeenCalledWith(expect.stringContaining(PRINCIPAL));
  });
});
