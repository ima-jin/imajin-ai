/**
 * Tests for the notification backlog replayer (#2044).
 *
 * ws-server.js calls this immediately after a DID's socket sends
 * `{type: 'connected'}`. What matters here: every returned frame is sent
 * down the connecting socket in order, a socket that closes mid-replay
 * stops rather than throwing, and a failed lookup degrades to "nothing
 * replayed this time" instead of breaking the connection handshake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ws-server.js and everything it loads is plain CJS, outside the Next build.
const { createNotificationBacklogReplayer } = require('../notification-backlog');

type Frame = { type: string; id: string };
type Socket = { readyState: number; send: (data: string) => void };

interface Replayer {
  replay(ws: Socket, did: string): Promise<void>;
}

const DID = 'did:imajin:veteze';

let fetchBacklog: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.fn>;

function makeReplayer(overrides: Record<string, unknown> = {}): Replayer {
  return createNotificationBacklogReplayer({ fetchBacklog, log, ...overrides }) as Replayer;
}

function makeSocket(readyState = 1): Socket {
  return { readyState, send: vi.fn() };
}

function frame(id: string): Frame {
  return { type: 'notification', id };
}

beforeEach(() => {
  fetchBacklog = vi.fn().mockResolvedValue({ frames: [], truncated: false });
  log = vi.fn();
});

describe('replay', () => {
  it('sends every returned frame down the socket, in order', async () => {
    fetchBacklog.mockResolvedValue({ frames: [frame('ntf_1'), frame('ntf_2')], truncated: false });
    const replayer = makeReplayer();
    const ws = makeSocket();

    await replayer.replay(ws, DID);

    expect(fetchBacklog).toHaveBeenCalledWith(DID);
    expect(ws.send).toHaveBeenNthCalledWith(1, JSON.stringify(frame('ntf_1')));
    expect(ws.send).toHaveBeenNthCalledWith(2, JSON.stringify(frame('ntf_2')));
  });

  it('sends nothing when the backlog is empty', async () => {
    const replayer = makeReplayer();
    const ws = makeSocket();

    await replayer.replay(ws, DID);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('stops sending once the socket is no longer open', async () => {
    fetchBacklog.mockResolvedValue({ frames: [frame('ntf_1'), frame('ntf_2')], truncated: false });
    const replayer = makeReplayer();
    const ws = makeSocket(3); // WebSocket.CLOSED

    await replayer.replay(ws, DID);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('logs, rather than throws, when the lookup fails', async () => {
    fetchBacklog.mockRejectedValue(new Error('kernel unreachable'));
    const replayer = makeReplayer();
    const ws = makeSocket();

    await expect(replayer.replay(ws, DID)).resolves.toBeUndefined();
    expect(ws.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(DID));
  });

  it('logs, rather than throws, when a send itself fails mid-replay', async () => {
    fetchBacklog.mockResolvedValue({ frames: [frame('ntf_1'), frame('ntf_2')], truncated: false });
    const ws = makeSocket();
    ws.send = vi.fn(() => { throw new Error('socket hung up'); });
    const replayer = makeReplayer();

    await expect(replayer.replay(ws, DID)).resolves.toBeUndefined();
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('logs when the backlog was truncated', async () => {
    fetchBacklog.mockResolvedValue({ frames: [frame('ntf_1')], truncated: true });
    const replayer = makeReplayer();

    await replayer.replay(makeSocket(), DID);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('truncated'));
  });

  it('tolerates the default no-op logger when none is injected', async () => {
    fetchBacklog.mockRejectedValue(new Error('kernel unreachable'));
    const replayer = createNotificationBacklogReplayer({ fetchBacklog }) as Replayer;

    await expect(replayer.replay(makeSocket(), DID)).resolves.toBeUndefined();
  });
});
