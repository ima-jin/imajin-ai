// @vitest-environment jsdom
/**
 * AcceptSection (#1834 Phase 2 — scopeDid + pendingAttestationId invite context).
 *
 * This component branches on session presence and on whether the invite
 * carries an `onboardUrl` (a scoped invite). The two dimensions combine into
 * the four render states below, plus the accept-request outcomes (success,
 * server error, network error) that each authenticated/unauthenticated path
 * can hit.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AcceptSection } from '../AcceptSection';

const LOGIN_URL = 'https://auth.example/login?next=x';
const CODE = 'abc123';
const CONNECTIONS_URL = 'https://connections.example';
const ONBOARD_URL = 'https://auth.example/onboard?scope=did%3Aimajin%3Ascope&invite=abc123';
const ACCEPT_URL = `/connections/api/invites/${CODE}/accept`;

type Props = Parameters<typeof AcceptSection>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Fetch stub: resolves the session check, and dispatches the accept call to `acceptImpl`. */
function installFetch(
  session: unknown,
  acceptImpl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }> = async () => ({
    ok: true,
    json: async () => ({}),
  }),
) {
  const spy = vi.fn(async (url: string) => {
    if (url === '/auth/api/session') {
      return session ? { ok: true, json: async () => session } : { ok: false, json: async () => null };
    }
    if (url === ACCEPT_URL) {
      return acceptImpl();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderSection(overrides: Partial<Props> = {}) {
  return render(
    <AcceptSection loginUrl={LOGIN_URL} code={CODE} connectionsUrl={CONNECTIONS_URL} onboardUrl={null} {...overrides} />,
  );
}

async function waitForSessionCheck() {
  await waitFor(() => expect(screen.queryByText('Checking session…')).toBeNull());
}

beforeEach(() => {
  // AcceptSection navigates via `globalThis.location.href = ...`; jsdom's real
  // setter attempts (and warns about) an actual navigation, so swap in a plain
  // object we can assert against instead.
  Object.defineProperty(window, 'location', {
    value: { ...window.location, href: '' },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session check', () => {
  it('shows a loading state before the session check resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    renderSection();

    expect(screen.getByText('Checking session…')).toBeDefined();
  });
});

describe('unauthenticated — unscoped invite (no onboardUrl)', () => {
  it('renders the register + login links, with the invite code threaded into the register link', async () => {
    installFetch(null);

    renderSection();
    await waitForSessionCheck();

    const registerLink = screen.getByText('Create Account & Connect').closest('a');
    expect(registerLink?.getAttribute('href')).toBe(`https://auth.example/register?invite=${CODE}&next=x`);
    expect(screen.getByText('Already have an account? Login').closest('a')?.getAttribute('href')).toBe(LOGIN_URL);
  });
});

describe('unauthenticated — scoped invite (onboardUrl set)', () => {
  it('renders a Continue CTA and a login fallback instead of the register link', async () => {
    installFetch(null);

    renderSection({ onboardUrl: ONBOARD_URL });
    await waitForSessionCheck();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined();
    expect(screen.queryByText('Create Account & Connect')).toBeNull();
    expect(screen.getByText('Already have an account? Login').closest('a')?.getAttribute('href')).toBe(LOGIN_URL);
  });

  it('shows the continuing state while the best-effort accept is in flight, then navigates to onboardUrl', async () => {
    const acceptCall = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchSpy = installFetch(null, () => acceptCall.promise);

    renderSection({ onboardUrl: ONBOARD_URL });
    await waitForSessionCheck();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect((screen.getByRole('button', { name: 'Continuing…' }) as HTMLButtonElement).disabled).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(ACCEPT_URL, expect.objectContaining({ method: 'POST' }));

    acceptCall.resolve({ ok: true, json: async () => ({}) });

    await waitFor(() => expect(window.location.href).toBe(ONBOARD_URL));
  });

  it('still navigates to onboardUrl when the best-effort accept call fails (login/onboarding stays available)', async () => {
    installFetch(null, () => {
      throw new Error('network down');
    });

    renderSection({ onboardUrl: ONBOARD_URL });
    await waitForSessionCheck();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(window.location.href).toBe(ONBOARD_URL));
  });
});

describe('authenticated', () => {
  const SESSION_WITH_HANDLE = { did: 'did:imajin:accepter', handle: 'acceptor' };
  const SESSION_NO_HANDLE = { did: 'did:imajin:accepter-without-a-handle' };

  it('displays the handle when the session has one', async () => {
    installFetch(SESSION_WITH_HANDLE);

    renderSection();
    await waitForSessionCheck();

    expect(screen.getByText('@acceptor')).toBeDefined();
  });

  it('falls back to a truncated DID when the session has no handle', async () => {
    installFetch(SESSION_NO_HANDLE);

    renderSection();
    await waitForSessionCheck();

    expect(screen.getByText(`${SESSION_NO_HANDLE.did.slice(0, 20)}...`)).toBeDefined();
  });

  it('shows the accepting state while the accept request is in flight, then Connected on success', async () => {
    const acceptCall = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    installFetch(SESSION_WITH_HANDLE, () => acceptCall.promise);

    renderSection();
    await waitForSessionCheck();

    fireEvent.click(screen.getByRole('button', { name: 'Accept Invite' }));

    await waitFor(() => expect((screen.getByRole('button', { name: 'Accepting…' }) as HTMLButtonElement).disabled).toBe(true));

    acceptCall.resolve({ ok: true, json: async () => ({}) });

    await waitFor(() => expect(screen.getByText('Connected!')).toBeDefined());
  });

  it('links to connectionsUrl when there is no onboardUrl for a successful accept', async () => {
    installFetch(SESSION_WITH_HANDLE);

    renderSection();
    await waitForSessionCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invite' }));

    await waitFor(() =>
      expect(screen.getByText('View Your Connections').closest('a')?.getAttribute('href')).toBe(CONNECTIONS_URL),
    );
  });

  it('links to onboardUrl instead of connectionsUrl when the invite carries scope context', async () => {
    installFetch(SESSION_WITH_HANDLE);

    renderSection({ onboardUrl: ONBOARD_URL });
    await waitForSessionCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invite' }));

    await waitFor(() => expect(screen.getByText('Continue').closest('a')?.getAttribute('href')).toBe(ONBOARD_URL));
  });

  it('surfaces the server error and re-enables the button on a failed accept', async () => {
    installFetch(SESSION_WITH_HANDLE, async () => ({
      ok: false,
      json: async () => ({ error: 'Invite already used' }),
    }));

    renderSection();
    await waitForSessionCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invite' }));

    await waitFor(() => expect(screen.getByText('Invite already used')).toBeDefined());
    expect((screen.getByRole('button', { name: 'Accept Invite' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('falls back to a generic error message when the server omits one', async () => {
    installFetch(SESSION_WITH_HANDLE, async () => ({ ok: false, json: async () => ({}) }));

    renderSection();
    await waitForSessionCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invite' }));

    await waitFor(() => expect(screen.getByText('Failed to accept invite')).toBeDefined());
  });

  it('shows a network-error message when the accept call throws', async () => {
    installFetch(SESSION_WITH_HANDLE, () => {
      throw new Error('offline');
    });

    renderSection();
    await waitForSessionCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invite' }));

    await waitFor(() => expect(screen.getByText('Network error — please try again')).toBeDefined());
    expect((screen.getByRole('button', { name: 'Accept Invite' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
