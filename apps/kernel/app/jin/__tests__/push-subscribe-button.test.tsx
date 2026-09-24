// @vitest-environment jsdom
/**
 * Component tests for the /jin push-subscribe button (#2291): the
 * checking/unsupported/unsubscribed/subscribed/busy/error states driven by
 * `GET/POST/DELETE /jin/api/push-subscriptions` and the browser's
 * `ServiceWorkerContainer`/`PushManager` APIs — neither of which jsdom
 * implements, so both are stubbed per-test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { PushSubscribeButton } from '../push-subscribe-button';

// A real base64 string (valid for atob) — the component's
// urlBase64ToUint8Array runs for real on whatever publicKey the GET
// response supplies, so this must actually decode.
const PUBLIC_KEY = 'cHVibGljS2V5';

interface FakeSubscription {
  endpoint: string;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
}

function makeSubscription(overrides: Partial<FakeSubscription> = {}): FakeSubscription {
  return {
    endpoint: 'https://push.example.com/abc',
    toJSON: () => ({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
    unsubscribe: vi.fn(async () => true),
    ...overrides,
  };
}

/** Stubs `navigator.serviceWorker` + `window.PushManager` so `pushSupported()` is true. */
function installPushSupport(options: { existingSubscription?: FakeSubscription | null } = {}) {
  const getSubscription = vi.fn(async () => options.existingSubscription ?? null);
  const subscribe = vi.fn(async () => makeSubscription());
  const registration = { pushManager: { getSubscription, subscribe } };
  const register = vi.fn(async () => registration);

  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    value: { register, ready: Promise.resolve(registration) },
    configurable: true,
  });
  (globalThis.window as unknown as { PushManager?: unknown }).PushManager = class {};

  return { registration, register, getSubscription, subscribe };
}

function removePushSupport(): void {
  const nav = globalThis.navigator as unknown as { serviceWorker?: unknown };
  delete nav.serviceWorker;
  delete (globalThis.window as unknown as { PushManager?: unknown }).PushManager;
}

type FetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

function okJson(body: unknown): FetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

function installFetch(handlers: {
  get?: () => FetchResponse | Promise<FetchResponse>;
  post?: () => FetchResponse | Promise<FetchResponse>;
  del?: () => FetchResponse | Promise<FetchResponse>;
}) {
  const spy = vi.fn((_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST') return Promise.resolve(handlers.post ? handlers.post() : okJson({ ok: true }));
    if (method === 'DELETE') return Promise.resolve(handlers.del ? handlers.del() : okJson({ ok: true }));
    return Promise.resolve(handlers.get ? handlers.get() : okJson({ isOperator: false }));
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  removePushSupport();
});

describe('checking / unsupported states', () => {
  it('renders nothing while the initial support/operator check is still in flight', () => {
    installPushSupport();
    // Never resolves — freezes the component in its initial 'checking' state
    // for the assertion below without leaving a dangling state update.
    installFetch({ get: () => new Promise<FetchResponse>(() => {}) });

    const { container } = render(<PushSubscribeButton />);

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing and never calls the API when the browser lacks push support', async () => {
    const fetchSpy = installFetch({});

    const { container } = render(<PushSubscribeButton />);

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders nothing for a non-operator even when push is supported', async () => {
    installPushSupport();
    installFetch({ get: () => okJson({ isOperator: false }) });

    const { container } = render(<PushSubscribeButton />);

    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders nothing when the operator check succeeds but no VAPID key is provisioned yet', async () => {
    installPushSupport();
    installFetch({ get: () => okJson({ isOperator: true, publicKey: null }) });

    const { container } = render(<PushSubscribeButton />);

    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});

describe('unsubscribed state', () => {
  it('shows "Enable phone push" when supported, operator, and not yet subscribed', async () => {
    installPushSupport({ existingSubscription: null });
    installFetch({ get: () => okJson({ isOperator: true, publicKey: PUBLIC_KEY }) });

    render(<PushSubscribeButton />);

    expect(await screen.findByRole('button', { name: 'Enable phone push' })).toBeDefined();
  });
});

describe('subscribed state', () => {
  it('shows "Disable phone push" when a subscription already exists', async () => {
    installPushSupport({ existingSubscription: makeSubscription() });
    installFetch({ get: () => okJson({ isOperator: true, publicKey: PUBLIC_KEY }) });

    render(<PushSubscribeButton />);

    expect(await screen.findByRole('button', { name: 'Disable phone push' })).toBeDefined();
  });

  it('subscribes and flips to "Disable phone push" on a successful enable', async () => {
    installPushSupport({ existingSubscription: null });
    installFetch({ get: () => okJson({ isOperator: true, publicKey: PUBLIC_KEY }) });

    render(<PushSubscribeButton />);
    const button = await screen.findByRole('button', { name: 'Enable phone push' });

    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Disable phone push' })).toBeDefined();
  });

  it('unsubscribes and flips back to "Enable phone push" on a successful disable', async () => {
    installPushSupport({ existingSubscription: makeSubscription() });
    installFetch({ get: () => okJson({ isOperator: true, publicKey: PUBLIC_KEY }) });

    render(<PushSubscribeButton />);
    const button = await screen.findByRole('button', { name: 'Disable phone push' });

    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Enable phone push' })).toBeDefined();
  });
});

describe('busy state', () => {
  it('disables the button and shows the busy label while the subscribe POST is in flight', async () => {
    installPushSupport({ existingSubscription: null });
    let resolvePost!: (value: FetchResponse) => void;
    const postPromise = new Promise<FetchResponse>((resolve) => {
      resolvePost = resolve;
    });
    installFetch({
      get: () => okJson({ isOperator: true, publicKey: PUBLIC_KEY }),
      post: () => postPromise,
    });

    render(<PushSubscribeButton />);
    const enableButton = await screen.findByRole('button', { name: 'Enable phone push' });

    fireEvent.click(enableButton);

    await waitFor(() => {
      const button = screen.getByRole('button') as HTMLButtonElement;
      expect(button.textContent).toBe('\u2026');
      expect(button.disabled).toBe(true);
    });

    resolvePost(okJson({ ok: true }));

    expect(await screen.findByRole('button', { name: 'Disable phone push' })).toBeDefined();
  });
});

describe('error state', () => {
  it('shows an error and reverts to "Enable phone push" when the subscribe POST fails', async () => {
    installPushSupport({ existingSubscription: null });
    installFetch({
      get: () => okJson({ isOperator: true, publicKey: PUBLIC_KEY }),
      post: () => ({ ok: false, status: 500, json: async () => ({}) }),
    });

    render(<PushSubscribeButton />);
    const button = await screen.findByRole('button', { name: 'Enable phone push' });

    fireEvent.click(button);

    expect(await screen.findByText('Could not enable phone notifications.')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Enable phone push' })).toBeDefined();
  });

  it('shows an error and stays subscribed when unsubscribing throws', async () => {
    const existing = makeSubscription({
      unsubscribe: vi.fn(async () => {
        throw new Error('unsubscribe failed');
      }),
    });
    installPushSupport({ existingSubscription: existing });
    installFetch({ get: () => okJson({ isOperator: true, publicKey: PUBLIC_KEY }) });

    render(<PushSubscribeButton />);
    const button = await screen.findByRole('button', { name: 'Disable phone push' });

    fireEvent.click(button);

    expect(await screen.findByText('Could not disable phone notifications.')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Disable phone push' })).toBeDefined();
  });
});
