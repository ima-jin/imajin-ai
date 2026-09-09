/**
 * Tests for the WS heartbeat (#2099).
 *
 * ws-server.js wires this to real sockets and a real `releaseWsClaims`
 * internal-route call; what matters here is the pure liveness state
 * machine: a socket that never pongs across `missedLimit` sweeps is
 * terminated and has its DID's claims released, a socket that pongs is
 * never terminated, and a socket with no DID yet is terminated without a
 * (meaningless) release call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ws-server.js and everything it loads is plain CJS, outside the Next build.
const { createHeartbeat } = require('../heartbeat');

interface FakeSocket {
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function makeSocket(): FakeSocket {
  return { ping: vi.fn(), terminate: vi.fn() };
}

let releaseClaims: ReturnType<typeof vi.fn>;
let onDead: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.fn>;

function makeHeartbeat(overrides: Record<string, unknown> = {}) {
  return createHeartbeat({ missedLimit: 2, releaseClaims, log, ...overrides });
}

beforeEach(() => {
  releaseClaims = vi.fn().mockResolvedValue(undefined);
  onDead = vi.fn();
  log = vi.fn();
});

describe('sweep — a socket that never pongs', () => {
  it('is not terminated on the first missed sweep, but is pinged again', () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    heartbeat.sweep([[ws, meta]], onDead); // ping #1 (fresh track counts as "alive")
    heartbeat.sweep([[ws, meta]], onDead); // missed pong #1 -> re-ping

    expect(ws.terminate).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(2);
  });

  it('is terminated after missing missedLimit consecutive pongs, and releases its DID claims', async () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    heartbeat.sweep([[ws, meta]], onDead); // sends ping #1
    heartbeat.sweep([[ws, meta]], onDead); // missed #1 -> sends ping #2
    heartbeat.sweep([[ws, meta]], onDead); // missed #2 -> terminate

    expect(onDead).toHaveBeenCalledWith(ws, meta);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    // onDead must run, and the socket must be removed from tracking, before
    // terminate() itself (#2099's "immediate removal" requirement).
    expect(onDead.mock.invocationCallOrder[0]).toBeLessThan(ws.terminate.mock.invocationCallOrder[0]);

    await vi.waitFor(() => expect(releaseClaims).toHaveBeenCalledWith(meta.did));
  });

  it('never pings, terminates, or releases claims again once terminated', () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    heartbeat.sweep([[ws, meta]], onDead);
    heartbeat.sweep([[ws, meta]], onDead);
    heartbeat.sweep([[ws, meta]], onDead); // terminated here
    heartbeat.sweep([[ws, meta]], onDead); // no longer tracked

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(releaseClaims).toHaveBeenCalledTimes(1);
  });

  it('does not call releaseClaims for a socket with no authenticated DID yet', () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: null };
    heartbeat.track(ws);

    heartbeat.sweep([[ws, meta]], onDead);
    heartbeat.sweep([[ws, meta]], onDead);
    heartbeat.sweep([[ws, meta]], onDead);

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(releaseClaims).not.toHaveBeenCalled();
  });
});

describe('sweep — a socket that pongs', () => {
  it('is never terminated as long as it keeps answering pings', () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    heartbeat.sweep([[ws, meta]], onDead); // ping #1
    heartbeat.markAlive(ws); // pong arrives
    heartbeat.sweep([[ws, meta]], onDead); // alive -> ping #2
    heartbeat.markAlive(ws);
    heartbeat.sweep([[ws, meta]], onDead); // alive -> ping #3

    expect(ws.terminate).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(3);
  });

  it('resets its missed count after a late pong, tolerating one earlier miss', () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    heartbeat.sweep([[ws, meta]], onDead); // ping #1
    heartbeat.sweep([[ws, meta]], onDead); // missed #1 -> ping #2
    heartbeat.markAlive(ws); // pong finally arrives
    heartbeat.sweep([[ws, meta]], onDead); // alive -> ping #3
    heartbeat.sweep([[ws, meta]], onDead); // missed #1 again -> ping #4 (not terminated)

    expect(ws.terminate).not.toHaveBeenCalled();
  });
});

describe('sweep — untracked sockets', () => {
  it('ignores a socket that was untracked (e.g. via a normal close)', () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);
    heartbeat.untrack(ws);

    heartbeat.sweep([[ws, meta]], onDead);

    expect(ws.ping).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('tolerates markAlive for a socket that was never tracked', () => {
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();

    expect(() => heartbeat.markAlive(ws)).not.toThrow();
  });
});

describe('releaseClaims failure handling', () => {
  it('logs, rather than throws, when releaseClaims rejects', async () => {
    releaseClaims.mockRejectedValueOnce(new Error('kernel unreachable'));
    const heartbeat = makeHeartbeat();
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    expect(() => {
      heartbeat.sweep([[ws, meta]], onDead);
      heartbeat.sweep([[ws, meta]], onDead);
      heartbeat.sweep([[ws, meta]], onDead);
    }).not.toThrow();

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining(meta.did)));
  });

  it('logs, rather than throws, when releaseClaims itself throws synchronously', () => {
    const throwingReleaseClaims = vi.fn(() => {
      throw new Error('boom');
    });
    const heartbeat = makeHeartbeat({ releaseClaims: throwingReleaseClaims });
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    expect(() => {
      heartbeat.sweep([[ws, meta]], onDead);
      heartbeat.sweep([[ws, meta]], onDead);
      heartbeat.sweep([[ws, meta]], onDead);
    }).not.toThrow();

    expect(log).toHaveBeenCalledWith(expect.stringContaining(meta.did));
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('tolerates the default no-op releaseClaims/log when none is injected', () => {
    const heartbeat = createHeartbeat({ missedLimit: 2 });
    const ws = makeSocket();
    const meta = { did: 'did:imajin:veteze' };
    heartbeat.track(ws);

    expect(() => {
      heartbeat.sweep([[ws, meta]], onDead);
      heartbeat.sweep([[ws, meta]], onDead);
      heartbeat.sweep([[ws, meta]], onDead);
    }).not.toThrow();
  });
});

describe('start', () => {
  it('sweeps on a recurring interval using a fresh view of the sockets each tick', () => {
    vi.useFakeTimers();
    try {
      const heartbeat = makeHeartbeat({ intervalMs: 30_000 });
      const ws = makeSocket();
      const meta = { did: 'did:imajin:veteze' };
      heartbeat.track(ws);
      const getSockets = vi.fn(() => [[ws, meta]] as Array<[FakeSocket, { did: string }]>);

      heartbeat.start(getSockets, onDead);
      vi.advanceTimersByTime(30_000);

      expect(getSockets).toHaveBeenCalledTimes(1);
      expect(ws.ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
