// @vitest-environment jsdom
/**
 * BumpConnect — floating promises (typescript:S9383) are now wrapped in
 * fireAndForget: fetchNodes (3 call sites), deactivate (5 call sites),
 * handleConfirm in the auto-decline timer and sendBumpEvent in the
 * accelerometer timer. Behaviour must be unchanged; a rejection of the
 * fire-and-forget task must be logged through console.error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import BumpConnect from '../BumpConnect';

const toastError = vi.fn();

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: { error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() } }),
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

// ─── WebSocket stub ──────────────────────────────────────────────────────────
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}

function emitWs(data: Record<string, unknown>) {
  const ws = FakeWebSocket.instances.at(-1)!;
  act(() => {
    ws.onmessage?.({ data: JSON.stringify(data) });
  });
}

// ─── fetch stub ──────────────────────────────────────────────────────────────
const NODES = { nodes: [{ id: 'n1', name: 'Node One', type: 'venue' }] };

interface FetchOpts {
  nodes?: () => Promise<unknown>;
  event?: () => Promise<unknown>;
  confirm?: () => Promise<unknown>;
  expiresAt?: string;
}

function installFetch(opts: FetchOpts = {}) {
  const spy = vi.fn(async (url: string) => {
    if (url.startsWith('/registry/api/bump/nodes')) {
      return opts.nodes ? opts.nodes() : { ok: true, json: async () => NODES };
    }
    if (url === '/registry/api/bump/activate') {
      return {
        ok: true,
        json: async () => ({
          sessionId: 's1',
          nodeId: 'n1',
          expiresAt: opts.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
        }),
      };
    }
    if (url === '/registry/api/bump/deactivate') return { ok: true, json: async () => ({}) };
    if (url === '/registry/api/bump/event') {
      return opts.event ? opts.event() : { ok: true, json: async () => ({ matched: true }) };
    }
    if (url === '/registry/api/bump/confirm') {
      return opts.confirm ? opts.confirm() : { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function callsTo(spy: ReturnType<typeof installFetch>, url: string) {
  return spy.mock.calls.filter(([u]) => u === url);
}

function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as RequestInit).body as string);
}

function setGeolocation(impl: unknown) {
  Object.defineProperty(navigator, 'geolocation', { value: impl, configurable: true });
}

async function startBumping() {
  await screen.findByText('Node One');
  fireEvent.click(screen.getByText('Start Bumping'));
  await screen.findByText('Bump to connect');
}

function shakeDevice() {
  const evt = Object.assign(new Event('devicemotion'), {
    acceleration: { x: 30, y: 0, z: 0 },
    accelerationIncludingGravity: { x: 0, y: 0, z: 0 },
    rotationRate: { alpha: 0, beta: 0, gamma: 0 },
    interval: 16,
  });
  act(() => {
    globalThis.dispatchEvent(evt);
  });
}

vi.stubGlobal('WebSocket', FakeWebSocket);

afterEach(() => {
  cleanup();
  FakeWebSocket.instances = [];
  Reflect.deleteProperty(navigator, 'geolocation');
  toastError.mockReset();
  vi.unstubAllGlobals();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.restoreAllMocks();
});

describe('fetchNodes call sites (geolocation effect)', () => {
  it('fetches all nodes when geolocation is unavailable', async () => {
    const spy = installFetch();
    render(<BumpConnect onClose={vi.fn()} />);

    await screen.findByText('Node One');
    expect(String(callsTo(spy, '/registry/api/bump/nodes')[0]?.[0] ?? '')).toBe('/registry/api/bump/nodes');
    expect(spy.mock.calls[0][0]).toBe('/registry/api/bump/nodes');
  });

  it('fetches nearby nodes with the coordinates when geolocation succeeds', async () => {
    setGeolocation({
      getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 1.5, longitude: 2.5 } }),
    });
    const spy = installFetch();
    render(<BumpConnect onClose={vi.fn()} />);

    await screen.findByText('Node One');
    expect(spy.mock.calls[0][0]).toBe('/registry/api/bump/nodes?lat=1.5&lng=2.5');
  });

  it('falls back to all nodes with a notice when geolocation fails', async () => {
    setGeolocation({
      getCurrentPosition: (_ok: unknown, fail: () => void) => fail(),
    });
    const spy = installFetch();
    render(<BumpConnect onClose={vi.fn()} />);

    await screen.findByText('Node One');
    expect(screen.getByText('Location unavailable — showing all nodes')).toBeDefined();
    expect(spy.mock.calls[0][0]).toBe('/registry/api/bump/nodes');
  });

  it('shows the empty state when the node fetch fails (existing handling, nothing rejects)', async () => {
    installFetch({ nodes: async () => { throw new Error('offline'); } });
    render(<BumpConnect onClose={vi.fn()} />);

    await screen.findByText('No nodes found nearby.');
  });
});

describe('deactivate call sites', () => {
  it('deactivates the session when Stop is pressed', async () => {
    const spy = installFetch();
    render(<BumpConnect onClose={vi.fn()} />);
    await startBumping();

    fireEvent.click(screen.getByText('Stop'));

    await waitFor(() => expect(callsTo(spy, '/registry/api/bump/deactivate')).toHaveLength(1));
    expect(bodyOf(callsTo(spy, '/registry/api/bump/deactivate')[0])).toEqual({ sessionId: 's1' });
    await screen.findByText('Bump');
  });

  it('deactivates the session and closes when ✕ is pressed while active', async () => {
    const onClose = vi.fn();
    const spy = installFetch();
    render(<BumpConnect onClose={onClose} />);
    await startBumping();

    fireEvent.click(screen.getByText('✕'));

    await waitFor(() => expect(callsTo(spy, '/registry/api/bump/deactivate')).toHaveLength(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not deactivate when ✕ is pressed before bumping started', async () => {
    const onClose = vi.fn();
    const spy = installFetch();
    render(<BumpConnect onClose={onClose} />);
    await screen.findByText('Node One');

    fireEvent.click(screen.getByText('✕'));

    expect(callsTo(spy, '/registry/api/bump/deactivate')).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deactivates and returns to idle when the session expires', async () => {
    const spy = installFetch({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    render(<BumpConnect onClose={vi.fn()} />);
    await screen.findByText('Node One');
    fireEvent.click(screen.getByText('Start Bumping'));

    await waitFor(() => expect(callsTo(spy, '/registry/api/bump/deactivate')).toHaveLength(1));
    expect(bodyOf(callsTo(spy, '/registry/api/bump/deactivate')[0])).toEqual({ sessionId: 's1' });
    await screen.findByText('Bump');
  });

  it('runs the unmount cleanup without deactivating when no session was captured', async () => {
    const spy = installFetch();
    const { unmount } = render(<BumpConnect onClose={vi.fn()} />);
    await screen.findByText('Node One');

    unmount();

    expect(callsTo(spy, '/registry/api/bump/deactivate')).toHaveLength(0);
  });
});

describe('sendBumpEvent (accelerometer timer)', () => {
  it('sends the bump event after the debounce when a spike is detected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const spy = installFetch();
    render(<BumpConnect onClose={vi.fn()} />);
    await startBumping();

    shakeDevice();

    await waitFor(() => expect(callsTo(spy, '/registry/api/bump/event')).toHaveLength(1));
    const payload = bodyOf(callsTo(spy, '/registry/api/bump/event')[0]);
    expect(payload.sessionId).toBe('s1');
    expect(payload.waveform).toEqual([30]);
    await screen.findByText('Matching...');
  });

  it('logs through fireAndForget when sendBumpEvent itself rejects', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const boom = new Error('console broke');
    installFetch({ event: async () => { throw new Error('offline'); } });
    render(<BumpConnect onClose={vi.fn()} />);
    await startBumping();
    // The component's own catch handler calls console.error first; making that
    // throw turns sendBumpEvent into a rejected promise.
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementationOnce(() => { throw boom; })
      .mockImplementation(() => {});

    shakeDevice();

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[bump:sendBumpEvent] unhandled async error', boom),
    );
  });
});

describe('auto-decline timer (handleConfirm)', () => {
  const matched = {
    type: 'bump:matched',
    matchId: 'm1',
    peer: { did: 'did:imajin:peer', handle: 'peer', name: 'Peer' },
    // already expired: the auto-decline timeout fires immediately
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };

  it('declines the match automatically when the confirmation window ends', async () => {
    const spy = installFetch();
    render(<BumpConnect onClose={vi.fn()} />);
    await screen.findByText('Node One');

    emitWs(matched);

    await waitFor(() => expect(callsTo(spy, '/registry/api/bump/confirm')).toHaveLength(1));
    expect(bodyOf(callsTo(spy, '/registry/api/bump/confirm')[0])).toEqual({ matchId: 'm1', accept: false });
    // no session -> back to idle
    await screen.findByText('Bump');
  });

  it('logs through fireAndForget when handleConfirm itself rejects', async () => {
    installFetch({ confirm: async () => ({ ok: false }) });
    const boom = new Error('toast broke');
    toastError.mockImplementation(() => { throw boom; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<BumpConnect onClose={vi.fn()} />);
    await screen.findByText('Node One');

    emitWs(matched);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[bump:handleConfirm:autoDecline] unhandled async error', boom),
    );
  });
});
