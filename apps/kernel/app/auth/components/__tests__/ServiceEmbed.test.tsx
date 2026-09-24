// @vitest-environment jsdom
/**
 * Tests for <ServiceEmbed> (#2275): loading/error states around the iframe,
 * the health-check gate, and the RFC-19 postMessage handshake in both
 * directions (docs/rfcs/RFC-19-kernel-userspace-architecture.md).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { resetServiceBadges, getServiceBadges } from '../../lib/service-badge-bus';

// Fixed for the whole file, and set BEFORE ../ServiceEmbed -> ../lib/service-registry
// is ever evaluated. A static `import ServiceEmbed from '../ServiceEmbed'` here
// would be hoisted above this assignment (ES module semantics run all static
// imports before any other top-level statement in the importing file), so
// service-registry would read an unset env var no matter where the line sat
// textually — hence the dynamic `loadServiceEmbed()` below instead.
const ORIGIN = 'https://coffee.example';
process.env.NEXT_PUBLIC_COFFEE_URL = ORIGIN;

async function loadServiceEmbed() {
  return (await import('../ServiceEmbed')).default;
}

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(overrides: { health?: unknown; healthStatus?: number; token?: unknown } = {}) {
  const { health = { ok: true, checked: true, status: 200 }, healthStatus = 200, token = { token: 'tok-123' } } =
    overrides;
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/api/services/health')) {
      return Promise.resolve(jsonResponse(health, healthStatus));
    }
    if (url.includes('/auth/api/tokens/app')) {
      return Promise.resolve(jsonResponse(token));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

/**
 * jsdom never actually navigates an iframe to a cross-origin `src` in tests
 * (no real network), so a real `contentWindow.postMessage()` call throws
 * internally (its target-origin bookkeeping is never populated). Every path
 * that fires the iframe's `load` event stubs that specific instance's
 * `postMessage` first, so the RFC-19 send effect never reaches the real
 * jsdom implementation.
 */
function stubPostMessage(iframe: HTMLIFrameElement) {
  return vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
}

/** Render, stub postMessage, fire `load`, and wait for ready — the common "app is up" starting point. */
async function renderReady(service = 'coffee') {
  const ServiceEmbed = await loadServiceEmbed();
  render(<ServiceEmbed service={service} did="did:imajin:abc" />);
  const iframe = await screen.findByTitle<HTMLIFrameElement>(`${service} dashboard`);
  const postMessageSpy = stubPostMessage(iframe);
  fireEvent.load(iframe);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  return { iframe, postMessageSpy };
}

beforeEach(() => {
  resetServiceBadges();
  mocks.toast.success.mockClear();
  mocks.toast.error.mockClear();
  mocks.toast.warning.mockClear();
  mocks.toast.info.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ServiceEmbed loading/error states (#2275)', () => {
  it('shows a spinner while the health check is in flight, then mounts the iframe once it passes', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const ServiceEmbed = await loadServiceEmbed();

    render(<ServiceEmbed service="coffee" did="did:imajin:abc" />);

    expect(screen.getByRole('status')).toBeDefined();
    const iframe = await screen.findByTitle<HTMLIFrameElement>('coffee dashboard');
    expect(iframe.src).toContain('https://coffee.example/dashboard');
    expect(iframe.src).toContain('embed=hub');
    expect(iframe.src).toContain('did=did%3Aimajin%3Aabc');
  });

  it('shows an error state instead of the iframe when the health check reports the service down', async () => {
    globalThis.fetch = mockFetch({ health: { ok: false, checked: true, status: 503 } }) as unknown as typeof fetch;
    const ServiceEmbed = await loadServiceEmbed();

    render(<ServiceEmbed service="coffee" did="did:imajin:abc" />);

    expect(await screen.findByText(/isn't responding right now/i)).toBeDefined();
    expect(screen.queryByTitle('coffee dashboard')).toBeNull();
  });

  it('shows an error state when the iframe never fires load within the handshake timeout', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const ServiceEmbed = await loadServiceEmbed();

    render(<ServiceEmbed service="coffee" did="did:imajin:abc" />);
    await screen.findByTitle('coffee dashboard');

    // Fire the handshake-timeout callback directly rather than waiting out
    // the real 10s window or fighting fake timers against already-resolved
    // fetch promises.
    const timeoutCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 10_000);
    expect(timeoutCallIndex).toBeGreaterThanOrEqual(0);
    const [callback] = setTimeoutSpy.mock.calls[timeoutCallIndex];
    const timerId = setTimeoutSpy.mock.results[timeoutCallIndex]!.value;
    act(() => {
      (callback as () => void)();
    });
    clearTimeout(timerId as ReturnType<typeof setTimeout>);

    expect(screen.getByText(/taking too long to load/i)).toBeDefined();
  });

  it('retries the health check and remounts the iframe when Retry is clicked', async () => {
    const fetchMock = mockFetch({ health: { ok: false, checked: true, status: 503 } });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const ServiceEmbed = await loadServiceEmbed();

    render(<ServiceEmbed service="coffee" did="did:imajin:abc" />);
    await screen.findByText(/isn't responding right now/i);

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/api/services/health')) return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse({ token: 'tok' }));
    });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByTitle('coffee dashboard')).toBeDefined();
  });
});

describe('ServiceEmbed Kernel -> App messages (RFC-19, #2275)', () => {
  it('sends theme and session messages to the iframe once it is ready', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { postMessageSpy } = await renderReady();

    await waitFor(() => {
      const types = postMessageSpy.mock.calls.map(([message]) => (message as { type: string }).type);
      expect(types).toContain('theme');
      expect(types).toContain('session');
    });
    const sessionCall = postMessageSpy.mock.calls.find(([m]) => (m as { type: string }).type === 'session');
    expect(sessionCall?.[0]).toEqual({ type: 'session', token: 'tok-123' });
    expect(sessionCall?.[1]).toBe(ORIGIN);
  });

  it('skips session minting for kernel-native services but still sends theme', async () => {
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const ServiceEmbed = await loadServiceEmbed();

    render(<ServiceEmbed service="pay" did="did:imajin:abc" />);
    const iframe = await screen.findByTitle<HTMLIFrameElement>('pay dashboard');
    const postMessageSpy = stubPostMessage(iframe);
    fireEvent.load(iframe);

    await waitFor(() =>
      expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'theme' }), expect.any(String)),
    );
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes('/auth/api/tokens/app'))).toBe(false);
  });

  it('sends an unload message when the embed unmounts', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { postMessageSpy } = await renderReady();
    await waitFor(() =>
      expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'theme' }), expect.any(String)),
    );
    postMessageSpy.mockClear();

    cleanup();

    expect(postMessageSpy).toHaveBeenCalledWith({ type: 'unload' }, ORIGIN);
  });
});

describe('ServiceEmbed App -> Kernel messages (RFC-19, #2275)', () => {
  function dispatchFromApp(iframe: HTMLIFrameElement, data: unknown, origin = ORIGIN) {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: iframe.contentWindow }));
  }

  it('updates document.title on set_title', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { iframe } = await renderReady();

    dispatchFromApp(iframe, { type: 'set_title', title: 'My Listing' });

    expect(document.title).toBe('My Listing · Imajin');
  });

  it('records the badge count on set_badge', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { iframe } = await renderReady();

    dispatchFromApp(iframe, { type: 'set_badge', count: 4 });

    expect(getServiceBadges()).toEqual({ coffee: 4 });
  });

  it('updates the visible URL on navigate when the path is relative', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { iframe } = await renderReady();
    const replaceStateSpy = vi.spyOn(globalThis.history, 'replaceState');

    dispatchFromApp(iframe, { type: 'navigate', path: '/listings/123' });

    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/auth/coffee/listings/123');
  });

  it('ignores a navigate message whose path is not a relative path', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { iframe } = await renderReady();
    const replaceStateSpy = vi.spyOn(globalThis.history, 'replaceState');

    dispatchFromApp(iframe, { type: 'navigate', path: 'https://evil.example/phish' });

    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('shows a toast at the requested level, defaulting to info for an unknown level', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { iframe } = await renderReady();

    dispatchFromApp(iframe, { type: 'toast', message: 'Purchase complete!', level: 'success' });
    dispatchFromApp(iframe, { type: 'toast', message: 'Something odd' });

    expect(mocks.toast.success).toHaveBeenCalledWith('Purchase complete!');
    expect(mocks.toast.info).toHaveBeenCalledWith('Something odd');
  });

  it('ignores a message from an unexpected origin', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    const { iframe } = await renderReady();

    dispatchFromApp(iframe, { type: 'set_title', title: 'Hijacked' }, 'https://evil.example');

    expect(document.title).not.toBe('Hijacked · Imajin');
  });

  it('ignores a well-formed message whose source is not this iframe', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    await renderReady();

    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'set_title', title: 'Spoofed' }, origin: ORIGIN, source: null }),
    );

    expect(document.title).not.toBe('Spoofed · Imajin');
  });
});
