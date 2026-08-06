/**
 * Notification WebSocket push (#1644).
 *
 * The push is the difference between an agent being woken by a completed Warp run
 * and having to poll for it, so what matters here is the frame that reaches the
 * socket and the guarantee that a failed push never becomes a thrown error — the
 * notification row is already persisted by the time this runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
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
