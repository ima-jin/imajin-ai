/**
 * Notification WebSocket push (#1644, #2099).
 *
 * The push is the difference between an agent being woken by a completed Warp run
 * and having to poll for it, so what matters here is the frame that reaches the
 * socket and the guarantee that a failed push never becomes a thrown error — the
 * notification row is already persisted by the time this runs. Since #2099, a
 * successful `.send()` no longer marks the row delivered on its own — only an
 * explicit ack does that (delivery.ts) — so this module's job is narrowed to
 * claiming/rolling back the WS-send *attempt*.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logMock, mockClaim, mockRollback } = vi.hoisted(() => ({
  logMock: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  mockClaim: vi.fn(),
  mockRollback: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('../delivery', () => ({
  claimNotificationForWsSend: mockClaim,
  rollbackWsClaim: mockRollback,
  WS_MAX_ATTEMPTS: 3,
}));

const RECIPIENT = 'did:imajin:veteze';
const INTERNAL_KEY = 'internal-key-value';

/** Import the module fresh, so the module-level env reads are re-evaluated. */
async function loadModule(env: { internalKey?: string; wsPort?: string } = {}) {
  vi.resetModules();
  if (env.internalKey === undefined) {
    delete process.env.AUTH_INTERNAL_API_KEY;
  } else {
    process.env.AUTH_INTERNAL_API_KEY = env.internalKey;
  }
  if (env.wsPort === undefined) {
    delete process.env.WS_PORT;
  } else {
    process.env.WS_PORT = env.wsPort;
  }
  return import('../ws-push');
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** The body the internal push route was called with. */
function pushedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body);
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  logMock.error.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  mockClaim.mockReset().mockResolvedValue({ claimed: true, attempts: 1 });
  mockRollback.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ─── Frame shape ─────────────────────────────────────────────────────────────

describe('buildNotificationFrame', () => {
  it('builds the notification frame from a stored row', async () => {
    const { buildNotificationFrame } = await loadModule({ internalKey: INTERNAL_KEY });

    const frame = buildNotificationFrame({
      id: 'ntf_abc123',
      scope: 'warp.run.completed',
      title: 'Warp run completed',
      body: 'Run SUCCEEDED: Nightly',
      data: { runId: '019f9990', state: 'SUCCEEDED' },
      createdAt: new Date('2026-08-06T05:00:00.000Z'),
    });

    expect(frame).toEqual({
      type: 'notification',
      id: 'ntf_abc123',
      scope: 'warp.run.completed',
      title: 'Warp run completed',
      body: 'Run SUCCEEDED: Nightly',
      data: { runId: '019f9990', state: 'SUCCEEDED' },
      createdAt: '2026-08-06T05:00:00.000Z',
    });
  });

  it('normalises an absent body and data rather than emitting undefined', async () => {
    const { buildNotificationFrame } = await loadModule({ internalKey: INTERNAL_KEY });

    const frame = buildNotificationFrame({
      id: 'ntf_abc123',
      scope: 'chat:mention',
      title: 'Someone mentioned you',
      createdAt: '2026-08-06T05:00:00.000Z',
    });

    expect(frame.body).toBeNull();
    expect(frame.data).toEqual({});
    expect(frame.createdAt).toBe('2026-08-06T05:00:00.000Z');
  });
});

// ─── Delivery ────────────────────────────────────────────────────────────────

describe('pushNotificationToDid', () => {
  const FRAME = {
    type: 'notification' as const,
    id: 'ntf_abc123',
    scope: 'warp.run.completed',
    title: 'Warp run completed',
    body: 'Run SUCCEEDED: Nightly',
    data: { runId: '019f9990' },
    createdAt: '2026-08-06T05:00:00.000Z',
  };

  it('posts the frame to the internal DID push route with the internal key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({
      internalKey: INTERNAL_KEY,
      wsPort: '3007',
    });

    const delivered = await pushNotificationToDid(RECIPIENT, FRAME);

    expect(delivered).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe('http://localhost:3007/chat/api/internal/did-push');
    expect(init.method).toBe('POST');
    expect(init.headers['x-internal-key']).toBe(INTERNAL_KEY);
    expect(pushedBody(fetchMock)).toEqual({ targetDid: RECIPIENT, event: FRAME });
  });

  it('reports not delivered when no socket for the DID was open', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: false }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });

    expect(await pushNotificationToDid(RECIPIENT, FRAME)).toBe(false);
  });

  it('warns when nobody was connected, instead of staying silent (2026-09-05 incident)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: false }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: FRAME.id, recipientDid: RECIPIENT }),
      expect.stringContaining('no connected socket'),
    );
  });

  it('does not warn when the push actually reached a socket', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('skips the push entirely when no internal key is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule();

    expect(await pushNotificationToDid(RECIPIENT, FRAME)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false on a non-2xx response instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });

    await expect(pushNotificationToDid(RECIPIENT, FRAME)).resolves.toBe(false);
  });

  it('swallows a transport failure — the row is already persisted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });

    await expect(pushNotificationToDid(RECIPIENT, FRAME)).resolves.toBe(false);
  });
});

// ─── WS-send claim guard (#2044, #2099) ─────────────────────────────────────

describe('pushNotificationToDid — WS-send claim guard', () => {
  const FRAME = {
    type: 'notification' as const,
    id: 'ntf_abc123',
    scope: 'warp.run.completed',
    title: 'Warp run completed',
    body: 'Run SUCCEEDED: Nightly',
    data: { runId: '019f9990' },
    createdAt: '2026-08-06T05:00:00.000Z',
  };

  it('claims the row before pushing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(mockClaim).toHaveBeenCalledWith(FRAME.id);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not push when the row was already claimed — e.g. a backlog replay won the race', async () => {
    mockClaim.mockResolvedValueOnce({ claimed: false, attempts: 0 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    const delivered = await pushNotificationToDid(RECIPIENT, FRAME);

    expect(delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it('does not roll back the claim when the push actually delivers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(mockRollback).not.toHaveBeenCalled();
  });

  it('never sets delivered_at itself -- a live send is not an ack (#2099)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    // The only DB-touching calls this module ever makes are the claim and,
    // on a failed attempt, the rollback -- never anything ack-shaped.
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it('rolls back the claim when nobody was connected, so a later backlog replay can still attempt it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: false }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(mockRollback).toHaveBeenCalledWith(FRAME.id);
  });

  it('rolls back the claim on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(mockRollback).toHaveBeenCalledWith(FRAME.id);
  });

  it('rolls back the claim on a transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(mockRollback).toHaveBeenCalledWith(FRAME.id);
  });

  it('fails open — still pushes — when the claim lookup itself throws', async () => {
    mockClaim.mockRejectedValueOnce(new Error('connection refused'));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    const delivered = await pushNotificationToDid(RECIPIENT, FRAME);

    expect(delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not throw when rolling back the claim itself fails', async () => {
    mockRollback.mockRejectedValueOnce(new Error('connection refused'));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: false }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });

    await expect(pushNotificationToDid(RECIPIENT, FRAME)).resolves.toBe(false);
  });

  it('never claims when no internal key is configured, so a disabled push cannot spend a re-offer', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule();
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('warns when this attempt spends the row\'s last permitted re-offer', async () => {
    mockClaim.mockResolvedValueOnce({ claimed: true, attempts: 3 });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: FRAME.id, attempts: 3 }),
      expect.stringContaining('re-offer cap'),
    );
  });

  it('does not warn about the cap before it is reached', async () => {
    mockClaim.mockResolvedValueOnce({ claimed: true, attempts: 1 });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ delivered: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { pushNotificationToDid } = await loadModule({ internalKey: INTERNAL_KEY });
    await pushNotificationToDid(RECIPIENT, FRAME);

    expect(logMock.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('re-offer cap'),
    );
  });
});
