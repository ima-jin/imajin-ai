/**
 * Tests for the `/jin` service worker (#2291): the `push` and
 * `notificationclick` handlers that display and route a web-push
 * notification. jsdom (and plain Node) implement neither
 * `ServiceWorkerGlobalScope` nor its `self`/`registration`/`clients`
 * globals, so this stubs the handful `sw.js` actually touches
 * (`addEventListener`, `skipWaiting`, `clients`, `registration`) and runs
 * the real script via a fresh dynamic import per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ListenerMap = Map<string, (event: unknown) => void>;

interface SwGlobals {
  handlers: ListenerMap;
  showNotification: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
}

function installServiceWorkerGlobalScope(): SwGlobals {
  const handlers: ListenerMap = new Map();
  const showNotification = vi.fn();
  const openWindow = vi.fn();
  const skipWaiting = vi.fn();
  const claim = vi.fn();

  vi.stubGlobal('addEventListener', (type: string, handler: (event: unknown) => void) => {
    handlers.set(type, handler);
  });
  vi.stubGlobal('skipWaiting', skipWaiting);
  vi.stubGlobal('clients', { claim, openWindow });
  vi.stubGlobal('registration', { showNotification });

  return { handlers, showNotification, openWindow, skipWaiting, claim };
}

describe('/jin service worker (sw.js)', () => {
  let sw: SwGlobals;

  beforeEach(async () => {
    sw = installServiceWorkerGlobalScope();
    // sw.js registers its listeners as a top-level side effect on import —
    // reset the module cache so each test gets a fresh execution against its
    // own freshly-stubbed globals rather than reusing a prior test's handlers.
    vi.resetModules();
    await import('../sw.js');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers install/activate/push/notificationclick handlers', () => {
    expect(sw.handlers.has('install')).toBe(true);
    expect(sw.handlers.has('activate')).toBe(true);
    expect(sw.handlers.has('push')).toBe(true);
    expect(sw.handlers.has('notificationclick')).toBe(true);
  });

  it('calls skipWaiting on install', () => {
    sw.handlers.get('install')?.({});

    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('claims every open client on activate', () => {
    const waitUntil = vi.fn();

    sw.handlers.get('activate')?.({ waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(sw.claim).toHaveBeenCalledTimes(1);
  });

  describe('push', () => {
    it('shows a notification using the push payload title/body/url', () => {
      const waitUntil = vi.fn();
      const event = {
        data: { json: () => ({ title: 'Operator approval needed', body: 'Restart the gateway.', url: '/jin?proposalId=opap_1' }) },
        waitUntil,
      };

      sw.handlers.get('push')?.(event);

      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(sw.showNotification).toHaveBeenCalledWith('Operator approval needed', {
        body: 'Restart the gateway.',
        data: { url: '/jin?proposalId=opap_1' },
        tag: '/jin?proposalId=opap_1',
      });
    });

    it('falls back to defaults when the push event carries no data', () => {
      const waitUntil = vi.fn();

      sw.handlers.get('push')?.({ data: null, waitUntil });

      expect(sw.showNotification).toHaveBeenCalledWith('imajin', { body: '', data: { url: '/jin' }, tag: '/jin' });
    });

    it('falls back to defaults when the push payload is not valid JSON', () => {
      const waitUntil = vi.fn();
      const event = {
        data: {
          json: () => {
            throw new Error('bad json');
          },
        },
        waitUntil,
      };

      sw.handlers.get('push')?.(event);

      expect(sw.showNotification).toHaveBeenCalledWith('imajin', { body: '', data: { url: '/jin' }, tag: '/jin' });
    });
  });

  describe('notificationclick', () => {
    it('closes the notification and opens the deep-linked window', () => {
      const waitUntil = vi.fn();
      const close = vi.fn();
      const event = { notification: { close, data: { url: '/jin?proposalId=opap_1' } }, waitUntil };

      sw.handlers.get('notificationclick')?.(event);

      expect(close).toHaveBeenCalledTimes(1);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(sw.openWindow).toHaveBeenCalledWith('/jin?proposalId=opap_1');
    });

    it('falls back to /jin when the notification carried no url', () => {
      const waitUntil = vi.fn();
      const close = vi.fn();

      sw.handlers.get('notificationclick')?.({ notification: { close, data: undefined }, waitUntil });

      expect(sw.openWindow).toHaveBeenCalledWith('/jin');
    });
  });
});
