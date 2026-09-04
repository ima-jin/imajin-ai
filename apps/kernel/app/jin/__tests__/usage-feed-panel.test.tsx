// @vitest-environment jsdom
/**
 * Component tests for the /jin live usage feed panel (#1864): grouping
 * rendered by session, delta coloring, the empty state, and the 10s poll
 * refresh — the panel's read contract against `GET
 * /auth/api/attestations/usage` (#1863).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import type { TurnUsageRow } from '../usage-feed-grouping';

// `useSearchParams` needs a Next router context that does not exist outside
// the app runtime — stub it per-test so `?subject_did=` overrides can be
// exercised without a real router.
const searchParamsMock = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
}));

import { UsageFeedPanel } from '../usage-feed-panel';

const JIN_DID = 'did:imajin:ADEKFWc2pbTKzfgzA3q6yrc1rEPNeMEP71mkBbCan54k';

function turn(overrides: Partial<TurnUsageRow> = {}): TurnUsageRow {
  return {
    id: 'att_1',
    issuedAt: new Date().toISOString(),
    sessionKey: 'agent:main:telegram:direct:1',
    model: 'anthropic/claude-opus-4-6',
    tokensIn: 12000,
    tokensOut: 800,
    tokenDelta: 0,
    sessionTokensIn: 12000,
    sessionTokensOut: 800,
    cost: { input: 0.18, output: 0.06, total: 0.24 },
    sessionCostTotal: 0.24,
    channel: 'telegram',
    durationMs: 8500,
    ...overrides,
  };
}

function installFetch(rows: TurnUsageRow[]) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => rows,
  } as unknown as Response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * A `fetch` stub whose responses are resolved manually by the test, so
 * overlapping-fetch / abort behavior can be exercised deterministically:
 * request N+1 can be started (and its abort effect on request N observed)
 * before request N's response ever arrives.
 */
function installControllableFetch() {
  const pending: Array<{ resolve: (response: unknown) => void; signal: AbortSignal | undefined }> = [];
  const spy = vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((resolve) => {
      pending.push({ resolve: resolve as (response: unknown) => void, signal: init?.signal ?? undefined });
    });
  });
  vi.stubGlobal('fetch', spy);
  return { spy, pending };
}

function jsonResponse(rows: TurnUsageRow[]) {
  return { ok: true, status: 200, json: async () => rows };
}

async function renderPanel(rows: TurnUsageRow[]) {
  const spy = installFetch(rows);
  render(<UsageFeedPanel />);
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return spy;
}

/**
 * Stub `setInterval`/`clearInterval` so the poll tick can be driven
 * deterministically (invoking the captured callback directly) instead of
 * depending on fake-timer/real-timer interplay with async fetch + React
 * effects, which is flaky in combination with `@testing-library/react`.
 */
function installIntervalSpy(): Array<() => void> {
  const callbacks: Array<() => void> = [];
  vi.stubGlobal('setInterval', vi.fn((cb: () => void) => {
    callbacks.push(cb);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }));
  vi.stubGlobal('clearInterval', vi.fn());
  return callbacks;
}

beforeEach(() => {
  // A subject is configured by default (via the query param) so tests that
  // are not specifically about DID resolution don't have to think about it.
  // The "subject DID resolution" and "no subject configured" suites below
  // override this per-test.
  searchParamsMock.current = new URLSearchParams(`subject_did=${encodeURIComponent(JIN_DID)}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_JIN_DID;
});

describe('empty state', () => {
  it('shows the empty-state copy from the issue when there are no turns yet', async () => {
    await renderPanel([]);

    expect(
      screen.getByText('No turns recorded yet. Agent usage attestations start after the next gateway restart.'),
    ).toBeDefined();
  });
});

describe('credentialed fetch (#1967)', () => {
  it('sends credentials with the usage feed fetch, so the now-authenticated endpoint keeps working', async () => {
    const spy = await renderPanel([turn({ id: 'row1' })]);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('/auth/api/attestations/usage'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('session grouping', () => {
  it('groups turns under one collapsible session header with running totals', async () => {
    await renderPanel([
      turn({ id: 'newer', sessionKey: 's1', tokensIn: 15000, tokensOut: 1000, tokenDelta: 3500, sessionTokensIn: 27000, sessionTokensOut: 1800, cost: { input: 0, output: 0, total: 0.14 }, sessionCostTotal: 0.24 }),
      turn({ id: 'older', sessionKey: 's1', tokensIn: 12000, tokensOut: 800, tokenDelta: 0, sessionTokensIn: 12000, sessionTokensOut: 800, cost: { input: 0, output: 0, total: 0.1 }, sessionCostTotal: 0.1 }),
    ]);

    expect(screen.getByText('s1')).toBeDefined();
    expect(screen.getByText('· 2 turns')).toBeDefined();
    expect(screen.getByText('27,000 in')).toBeDefined();
    expect(screen.getByText('1,800 out')).toBeDefined();
  });

  it('renders separate session groups for turns from different sessions, newest session first', async () => {
    await renderPanel([
      turn({ id: 'a1', sessionKey: 'session-a' }),
      turn({ id: 'b1', sessionKey: 'session-b' }),
    ]);

    const headers = screen.getAllByRole('button', { name: /session-/ });
    expect(headers.map((el) => el.textContent)).toEqual([
      expect.stringContaining('session-a'),
      expect.stringContaining('session-b'),
    ]);
  });

  it('collapses a session group when its header is clicked, hiding the turn rows', async () => {
    await renderPanel([turn({ id: 'row1', sessionKey: 's1' })]);

    expect(screen.getByText('anthropic/claude-opus-4-6')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /s1/ }));

    expect(screen.queryByText('anthropic/claude-opus-4-6')).toBeNull();
  });

  it('exposes expanded/collapsed state to assistive tech via aria-expanded', async () => {
    await renderPanel([turn({ id: 'row1', sessionKey: 's1' })]);

    const toggle = screen.getByRole('button', { name: /s1/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('token delta coloring', () => {
  it('colors a higher token delta red', async () => {
    await renderPanel([turn({ id: 'row1', tokenDelta: 3500 })]);

    const cell = screen.getByText('+3,500');
    expect(cell.className).toContain('text-red-400');
  });

  it('colors a lower token delta green', async () => {
    await renderPanel([turn({ id: 'row1', tokenDelta: -2000 })]);

    const cell = screen.getByText('-2,000');
    expect(cell.className).toContain('text-green-400');
  });

  it('colors a first turn (zero delta) gray and labels it distinctly', async () => {
    await renderPanel([turn({ id: 'row1', tokenDelta: 0 })]);

    const cell = screen.getByText('first turn');
    expect(cell.className).toContain('text-gray-500');
  });
});

describe('poll refresh', () => {
  it('registers a 10s poll interval and refetches the feed on each tick', async () => {
    const callbacks = installIntervalSpy();
    const spy = await renderPanel([turn({ id: 'row1' })]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(globalThis.setInterval).toHaveBeenCalledWith(expect.any(Function), 10_000);

    callbacks[0]();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('does not show the loading state during a silent poll refresh', async () => {
    const callbacks = installIntervalSpy();
    await renderPanel([turn({ id: 'row1' })]);

    callbacks[0]();

    await waitFor(() => expect(screen.getByText('anthropic/claude-opus-4-6')).toBeDefined());
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

describe('subject DID resolution', () => {
  it('never falls back to a hardcoded DID — fetches nothing when neither the query param nor the env var is set', async () => {
    searchParamsMock.current = new URLSearchParams();
    const spy = installFetch([]);
    render(<UsageFeedPanel />);

    expect(await screen.findByText(/No subject DID configured/)).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('queries with NEXT_PUBLIC_JIN_DID when no query param is present', async () => {
    searchParamsMock.current = new URLSearchParams();
    process.env.NEXT_PUBLIC_JIN_DID = JIN_DID;

    const spy = await renderPanel([]);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(`subject_did=${encodeURIComponent(JIN_DID)}`),
      expect.anything(),
    );
  });

  it('queries with the subject_did query param when present, overriding the env var', async () => {
    process.env.NEXT_PUBLIC_JIN_DID = JIN_DID;
    searchParamsMock.current = new URLSearchParams('subject_did=did:imajin:someone-else');

    const spy = await renderPanel([]);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(`subject_did=${encodeURIComponent('did:imajin:someone-else')}`),
      expect.anything(),
    );
  });
});

describe('no subject configured', () => {
  it('renders a distinct empty state (not the "no turns yet" copy) and never calls fetch', async () => {
    searchParamsMock.current = new URLSearchParams();
    const spy = installFetch([]);
    render(<UsageFeedPanel />);

    expect(await screen.findByText(/No subject DID configured/)).toBeDefined();
    expect(screen.queryByText(/No turns recorded yet/)).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('hides the refresh control when no subject is configured', async () => {
    searchParamsMock.current = new URLSearchParams();
    installFetch([]);
    render(<UsageFeedPanel />);

    await screen.findByText(/No subject DID configured/);
    expect(screen.queryByRole('button', { name: '↺ refresh' })).toBeNull();
  });
});

describe('overlapping-fetch guard', () => {
  it('aborts the in-flight request when a new fetch starts before it resolves', async () => {
    const { spy, pending } = installControllableFetch();
    render(<UsageFeedPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const first = pending[0];
    expect(first.signal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '↺ refresh' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    expect(first.signal?.aborted).toBe(true);
  });

  it('ignores a stale response that resolves after a newer request has already completed', async () => {
    const { spy, pending } = installControllableFetch();
    render(<UsageFeedPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '↺ refresh' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    // Newer request resolves first with the current data...
    pending[1].resolve(jsonResponse([turn({ id: 'fresh' })]));
    await waitFor(() => expect(screen.getByText('anthropic/claude-opus-4-6')).toBeDefined());

    // ...then the stale first request finally resolves with different data.
    // It must be ignored (its controller was aborted), not overwrite the feed.
    pending[0].resolve(jsonResponse([turn({ id: 'stale', sessionKey: 'stale-session' })]));

    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByText('stale-session')).toBeNull();
  });
});

describe('unmount cleanup', () => {
  it('clears the poll interval on unmount', async () => {
    installIntervalSpy();
    const { unmount } = render(<UsageFeedPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());

    unmount();

    expect(globalThis.clearInterval).toHaveBeenCalled();
  });

  it('aborts an in-flight request on unmount so a late response can never call setState after unmount', async () => {
    const { spy, pending } = installControllableFetch();
    const { unmount } = render(<UsageFeedPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    unmount();

    expect(pending[0].signal?.aborted).toBe(true);

    // Resolving after unmount must not throw (React would warn/error on a
    // setState call against an unmounted component if the abort guard were
    // missing).
    expect(() => pending[0].resolve(jsonResponse([turn({ id: 'late' })]))).not.toThrow();
  });
});

describe('response error handling', () => {
  it('shows an error banner when the endpoint responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)));
    render(<UsageFeedPanel />);

    expect(await screen.findByText('Failed to load usage feed (500)')).toBeDefined();
  });

  it('shows an error banner when the response body does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ not: 'an array' }) } as unknown as Response)));
    render(<UsageFeedPanel />);

    expect(await screen.findByText('Usage feed returned an unexpected response shape')).toBeDefined();
  });
});

describe('row fields', () => {
  it('renders tokens in/out, model badge, and cost for a turn', async () => {
    await renderPanel([turn({ id: 'row1', tokensIn: 12000, tokensOut: 800, cost: { input: 0.18, output: 0.06, total: 0.24 } })]);

    const row = screen.getByText('anthropic/claude-opus-4-6').closest('tr') as HTMLElement;
    expect(within(row).getByText('12,000')).toBeDefined();
    expect(within(row).getByText('800')).toBeDefined();
    expect(within(row).getByText('$0.2400')).toBeDefined();
  });

  it('shows the full session id as a title attribute for hover, truncating the visible label', async () => {
    const longSession = 'agent:main:telegram:direct:8321865723';
    await renderPanel([turn({ id: 'row1', sessionKey: longSession })]);

    const header = screen.getByRole('button', { name: new RegExp(longSession.slice(0, 10)) });
    const labelEl = within(header).getByTitle(longSession);
    expect(labelEl).toBeDefined();
  });
});
