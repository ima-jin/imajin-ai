// @vitest-environment jsdom
/**
 * Component tests for the /jin "Provision app" form (#2559): the operator-only
 * visibility gate, client-side refusal of bad input, the submit path against
 * the EXISTING `POST /api/apps/provision`, the 201 / 200-already-pending /
 * already-succeeded / error response states, and the post-decision result
 * read back from `GET /api/apps/provision?slug=`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { ProvisionAppPanel } from '../provision-app-panel';
import { installIntervalSpy } from './panel-test-support';

const APPROVALS_POLL_URL = '/jin/api/operator-approvals?source=apps';
const PROVISIONED_APPS_URL = '/api/apps/provision?status=succeeded';

interface Reply {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

interface FetchOptions {
  isOperator?: boolean;
  approvalsOk?: boolean;
  approvals?: Array<{
    proposalId: string;
    status: string;
    detail?: Record<string, unknown> | null;
    decision?: { decidedAt?: string } | null;
  }>;
  post?: Reply;
  ledger?: Reply;
  /** `GET /api/apps/provision?status=succeeded` (#2745) — the server-backed list of provisioned apps. */
  provisions?: Reply;
}

function reply({ ok = true, status = 200, body = {} }: Reply): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Mutable fixture so a test can move the proposal through its lifecycle between poll ticks. */
function installFetch(initial: FetchOptions = {}) {
  const state: FetchOptions = {
    isOperator: true,
    approvalsOk: true,
    approvals: [],
    post: { status: 201, body: { status: 'pending', proposalId: 'appprov_1' } },
    ledger: { ok: false, status: 404, body: { error: 'none' } },
    provisions: { body: { isOperator: true, provisions: [] } },
    ...initial,
  };
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/apps/provision' && init?.method === 'POST') {
      return reply(state.post ?? {});
    }
    if (url.startsWith('/api/apps/provision?slug=')) {
      return reply(state.ledger ?? {});
    }
    if (url === PROVISIONED_APPS_URL) {
      return reply(state.provisions ?? {});
    }
    if (url === '/jin/api/operator-approvals' || url === APPROVALS_POLL_URL) {
      return reply({ ok: state.approvalsOk, body: { isOperator: state.isOperator, approvals: state.approvals } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', spy);
  return { state, spy };
}

function postCalls(spy: ReturnType<typeof installFetch>['spy']) {
  return spy.mock.calls.filter(([url, init]) => url === '/api/apps/provision' && init?.method === 'POST');
}

async function renderVisible() {
  render(<ProvisionAppPanel />);
  await screen.findByTestId('provision-app-panel');
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value } });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Propose provision' }));
  });
}

async function proposeCoffee() {
  fill('Slug', 'coffee');
  fill('Display name', 'Coffee');
  await submit();
}

async function tick(callbacks: Array<() => void>) {
  await act(async () => {
    for (const cb of callbacks) cb();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProvisionAppPanel visibility', () => {
  it('renders nothing for a non-operator', async () => {
    const { spy } = installFetch({ isOperator: false });
    render(<ProvisionAppPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('provision-app-panel')).toBeNull();
  });

  it('renders nothing when the approvals route is unavailable', async () => {
    const { spy } = installFetch({ approvalsOk: false });
    render(<ProvisionAppPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('provision-app-panel')).toBeNull();
  });

  it('renders nothing when the operator check fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<ProvisionAppPanel />);
    await act(async () => {});
    expect(screen.queryByTestId('provision-app-panel')).toBeNull();
  });

  it('shows the form to the operator with the template defaulted and every field labelled', async () => {
    installFetch();
    await renderVisible();
    expect(screen.getByLabelText(/Slug/)).toBeDefined();
    expect(screen.getByLabelText(/Display name/)).toBeDefined();
    expect((screen.getByLabelText(/Template/) as HTMLInputElement).value).toBe('ima-jin/imajin-app-template');
    expect(screen.getByLabelText(/Attestation types/)).toBeDefined();
  });
});

describe('ProvisionAppPanel validation', () => {
  it('refuses a bad slug before anything is proposed', async () => {
    const { spy } = installFetch();
    await renderVisible();
    fill('Slug', 'Bad Slug');
    fill('Display name', 'Coffee');
    await submit();

    const slug = screen.getByLabelText(/Slug/);
    expect(slug.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/Slug must be lowercase/);
    expect(postCalls(spy)).toHaveLength(0);
  });

  it('requires a display name', async () => {
    const { spy } = installFetch();
    await renderVisible();
    fill('Slug', 'coffee');
    await submit();

    expect(screen.getByRole('alert').textContent).toMatch(/Display name is required/);
    expect(postCalls(spy)).toHaveLength(0);
  });

  it('refuses attestation types outside the slug namespace', async () => {
    const { spy } = installFetch();
    await renderVisible();
    fill('Slug', 'coffee');
    fill('Display name', 'Coffee');
    fill('Attestation types', 'other/order');
    await submit();

    expect(screen.getByRole('alert').textContent).toMatch(/must start with 'coffee\/'/);
    expect(postCalls(spy)).toHaveLength(0);
  });
});

describe('ProvisionAppPanel submit', () => {
  it('posts the payload to the existing route and shows the proposalId with a link to its card', async () => {
    const { spy } = installFetch();
    await renderVisible();
    fill('Slug', 'coffee');
    fill('Display name', 'Coffee');
    fill('Attestation types', 'coffee/order, coffee/review');
    await submit();

    const calls = postCalls(spy);
    expect(calls).toHaveLength(1);
    const init = calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({
      slug: 'coffee',
      displayName: 'Coffee',
      template: 'ima-jin/imajin-app-template',
      attestationTypes: ['coffee/order', 'coffee/review'],
    });

    expect((await screen.findByTestId('provision-proposal-id')).textContent).toBe('appprov_1');
    expect(screen.getByText('Proposal raised')).toBeDefined();
    const link = screen.getByRole('link', { name: /review it in Operator approvals/ });
    expect(link.getAttribute('href')).toBe('#approval-appprov_1');
  });

  it('shows a 200 existing proposal as "already pending", not as an error', async () => {
    installFetch({ post: { status: 200, body: { status: 'pending', proposalId: 'appprov_old' } } });
    await renderVisible();
    await proposeCoffee();

    expect(await screen.findByText('Already pending')).toBeDefined();
    expect(screen.getByTestId('provision-proposal-id').textContent).toBe('appprov_old');
    expect(screen.queryByText(/Failed to propose/)).toBeNull();
    expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('awaiting-approval');
  });

  it('shows the cached result when the slug was already provisioned', async () => {
    installFetch({
      post: {
        status: 200,
        body: { status: 'succeeded', slug: 'coffee', appDid: 'did:imajin:app1', repoUrl: 'https://github.com/ima-jin/coffee', secretsSet: [] },
      },
    });
    await renderVisible();
    await proposeCoffee();

    expect(await screen.findByText('Already provisioned')).toBeDefined();
    expect(screen.getByText('did:imajin:app1')).toBeDefined();
    expect(screen.getByRole('link', { name: 'https://github.com/ima-jin/coffee' }).getAttribute('href')).toBe('https://github.com/ima-jin/coffee');
    expect(screen.queryByTestId('provision-proposal-id')).toBeNull();
  });

  it('shows the server error for a rejected proposal', async () => {
    installFetch({ post: { ok: false, status: 400, body: { error: 'slug must be a lowercase, hyphenated identifier' } } });
    await renderVisible();
    await proposeCoffee();

    expect(await screen.findByText('slug must be a lowercase, hyphenated identifier')).toBeDefined();
    expect(screen.queryByTestId('provision-result')).toBeNull();
  });

  it('falls back to a status-code message when the error body is unreadable', async () => {
    const { state } = installFetch();
    state.post = { ok: false, status: 500, body: {} };
    await renderVisible();
    await proposeCoffee();

    expect(await screen.findByText('Failed to propose apps.provision (500)')).toBeDefined();
  });

  it('reports a network failure', async () => {
    const { spy } = installFetch();
    spy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/apps/provision' && init?.method === 'POST') throw new Error('offline');
      return reply({ body: { isOperator: true, approvals: [] } });
    });
    await renderVisible();
    await proposeCoffee();

    expect(await screen.findByText('Network error — apps.provision was not proposed')).toBeDefined();
  });

  it('reports an unexpected 2xx body', async () => {
    installFetch({ post: { status: 201, body: { status: 'weird' } } });
    await renderVisible();
    await proposeCoffee();

    expect(await screen.findByText('Unexpected response from apps.provision')).toBeDefined();
    expect(screen.queryByTestId('provision-result')).toBeNull();
  });
});

/** Approvals-list fetches made by the poll (everything except the operator-gate check). */
function pollCalls(spy: ReturnType<typeof installFetch>['spy']) {
  return spy.mock.calls.filter(([url]) => String(url).startsWith('/jin/api/operator-approvals?'));
}

const ISO_PAST = '2026-01-01T00:00:00.000Z';
const ISO_DECIDED = '2026-06-01T12:00:00.000Z';
const ISO_AFTER = '2026-06-01T12:00:05.000Z';

function failedLedger(updatedAt?: string): Reply {
  return {
    status: 200,
    body: { slug: 'coffee', status: 'failed', appDid: null, repoUrl: null, failedStep: 'register', errorMessage: 'old failure', updatedAt },
  };
}

describe('ProvisionAppPanel poll scope', () => {
  it('requests only source=apps approvals on every poll tick', async () => {
    const callbacks = installIntervalSpy();
    const { spy } = installFetch({ approvals: [{ proposalId: 'appprov_1', status: 'pending' }] });
    await renderVisible();
    await proposeCoffee();
    await waitFor(() => expect(pollCalls(spy).length).toBeGreaterThan(0));
    await tick(callbacks);

    const polls = pollCalls(spy);
    expect(polls.length).toBeGreaterThanOrEqual(2);
    for (const [url, init] of polls) {
      expect(url).toBe(APPROVALS_POLL_URL);
      expect((init as RequestInit).credentials).toBe('include');
    }
    // No unscoped list fetch beyond the one-time operator gate.
    const unscoped = spy.mock.calls.filter(([url]) => url === '/jin/api/operator-approvals');
    expect(unscoped).toHaveLength(1);
  });
});

describe('ProvisionAppPanel expired proposals', () => {
  it('shows a pending card past its expiresAt as expired and stops polling', async () => {
    installIntervalSpy();
    const { spy } = installFetch({
      approvals: [{ proposalId: 'appprov_1', status: 'pending', detail: { expiresAt: ISO_PAST } }],
    });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('declined'));
    expect(screen.getByText(/The proposal expired\. Nothing was provisioned\./)).toBeDefined();
    expect(screen.queryByText('Waiting for your approval below.')).toBeNull();
    expect(vi.mocked(globalThis.clearInterval)).toHaveBeenCalled();

    // Terminal: only the immediate tick ran, the interval was cleared, and no ledger read was needed.
    expect(pollCalls(spy)).toHaveLength(1);
    expect(spy.mock.calls.some(([url]) => String(url).startsWith('/api/apps/provision?slug='))).toBe(false);
  });

  it('keeps a pending card with a future expiresAt awaiting approval', async () => {
    installIntervalSpy();
    installFetch({
      approvals: [{ proposalId: 'appprov_1', status: 'pending', detail: { expiresAt: '2999-01-01T00:00:00.000Z' } }],
    });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('awaiting-approval'));
  });

  it('shows an expired status reported by the card as declined', async () => {
    installIntervalSpy();
    installFetch({ approvals: [{ proposalId: 'appprov_1', status: 'expired' }] });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('declined'));
  });
});

describe('ProvisionAppPanel stale ledger on re-propose', () => {
  it('does not show a failure older than the approval as the new result', async () => {
    const callbacks = installIntervalSpy();
    const { state } = installFetch({
      approvals: [{ proposalId: 'appprov_2', status: 'approved', decision: { decidedAt: ISO_DECIDED } }],
      ledger: failedLedger(ISO_PAST),
      post: { status: 201, body: { status: 'pending', proposalId: 'appprov_2' } },
    });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('running'));
    expect(screen.queryByText('old failure')).toBeNull();

    // The new run starts: ledger is flipped to pending after the decision, then succeeds.
    state.ledger = { status: 200, body: { slug: 'coffee', status: 'pending', appDid: null, repoUrl: null, failedStep: null, errorMessage: null, updatedAt: ISO_AFTER } };
    await tick(callbacks);
    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('running'));

    state.ledger = failedLedger(ISO_AFTER);
    await tick(callbacks);
    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('failed'));
    expect(screen.getByText('old failure')).toBeDefined();
  });

  it('accepts a ledger row that is newer than the decision', async () => {
    installIntervalSpy();
    installFetch({
      approvals: [{ proposalId: 'appprov_1', status: 'applied', decision: { decidedAt: ISO_DECIDED } }],
      ledger: failedLedger(ISO_AFTER),
    });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('failed'));
  });
});

describe('ProvisionAppPanel repoUrl guard', () => {
  async function renderSucceededWith(repoUrl: string) {
    installFetch({
      post: { status: 200, body: { status: 'succeeded', slug: 'coffee', appDid: 'did:imajin:app1', repoUrl, secretsSet: [] } },
    });
    await renderVisible();
    await proposeCoffee();
    await screen.findByText('Already provisioned');
  }

  it('renders a non-GitHub repoUrl as plain text, not a link', async () => {
    await renderSucceededWith('javascript:alert(1)');
    expect(screen.getByText('javascript:alert(1)')).toBeDefined();
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();
  });

  it('renders an https URL on another host as plain text', async () => {
    await renderSucceededWith('https://evil.example/ima-jin/coffee');
    expect(screen.queryByRole('link', { name: /evil\.example/ })).toBeNull();
    expect(screen.getByText('https://evil.example/ima-jin/coffee')).toBeDefined();
  });
});

describe('ProvisionAppPanel result tracking', () => {
  it('moves from awaiting approval to the provisioned result without manual polling', async () => {
    const callbacks = installIntervalSpy();
    const { state } = installFetch({ approvals: [{ proposalId: 'appprov_1', status: 'pending' }] });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('awaiting-approval'));
    expect(screen.getByText('Waiting for your approval below.')).toBeDefined();

    // Approved; the run is now in flight.
    state.approvals = [{ proposalId: 'appprov_1', status: 'approved' }];
    state.ledger = { status: 200, body: { slug: 'coffee', status: 'pending', appDid: null, repoUrl: null, failedStep: null, errorMessage: null } };
    await tick(callbacks);
    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('running'));

    // Done.
    state.approvals = [{ proposalId: 'appprov_1', status: 'applied' }];
    state.ledger = {
      status: 200,
      body: { slug: 'coffee', status: 'succeeded', appDid: 'did:imajin:coffee', repoUrl: 'https://github.com/ima-jin/coffee', failedStep: null, errorMessage: null },
    };
    await tick(callbacks);
    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('succeeded'));
    expect(screen.getByText('did:imajin:coffee')).toBeDefined();
    expect(screen.getByRole('link', { name: 'https://github.com/ima-jin/coffee' })).toBeDefined();
  });

  it('shows failedStep and errorMessage when provisioning failed', async () => {
    installFetch({
      approvals: [{ proposalId: 'appprov_1', status: 'applied' }],
      ledger: {
        status: 200,
        body: { slug: 'coffee', status: 'failed', appDid: null, repoUrl: null, failedStep: 'register', errorMessage: 'unique slug constraint' },
      },
    });
    installIntervalSpy();
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('failed'));
    expect(screen.getByText('register')).toBeDefined();
    expect(screen.getByText('unique slug constraint')).toBeDefined();
  });

  it('shows a declined proposal and stops following it', async () => {
    installIntervalSpy();
    const { spy } = installFetch({ approvals: [{ proposalId: 'appprov_1', status: 'denied' }] });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('declined'));
    expect(screen.getByText(/The proposal was denied/)).toBeDefined();
    expect(spy.mock.calls.some(([url]) => String(url).startsWith('/api/apps/provision?slug='))).toBe(false);
  });

  it('keeps waiting when neither the card nor a run can be read yet', async () => {
    installIntervalSpy();
    installFetch({ approvals: [], ledger: { ok: false, status: 404 } });
    await renderVisible();
    await proposeCoffee();

    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('awaiting-approval'));
  });

  it('stops polling on unmount', async () => {
    installIntervalSpy();
    installFetch();
    const { unmount } = render(<ProvisionAppPanel />);
    await screen.findByTestId('provision-app-panel');
    await proposeCoffee();
    await screen.findByTestId('provision-result');
    unmount();
    expect(vi.mocked(globalThis.clearInterval)).toHaveBeenCalled();
  });
});

describe('ProvisionAppPanel provisioned apps list (#2745)', () => {
  const unclaimed = { slug: 'learn', appDid: 'did:imajin:app-learn', repoUrl: 'https://github.com/ima-jin/learn', claimed: false };
  const claimed = { slug: 'dykil', appDid: 'did:imajin:app-dykil', repoUrl: 'https://github.com/ima-jin/dykil', claimed: true };

  it('lists an approved provision with Reissue claim code after a reload — no tracked proposal needed', async () => {
    // A fresh mount stands in for the reload: nothing was proposed in this page state.
    const { spy } = installFetch({ provisions: { body: { isOperator: true, provisions: [unclaimed] } } });
    await renderVisible();

    const row = await screen.findByTestId('provisioned-app');
    expect(row.getAttribute('data-slug')).toBe('learn');
    expect(row.textContent).toContain('unclaimed');
    expect(screen.getByRole('button', { name: 'Reissue claim code' })).toBeDefined();
    expect(screen.queryByTestId('provision-result')).toBeNull();
    expect(spy).toHaveBeenCalledWith(PROVISIONED_APPS_URL, { credentials: 'include' });
  });

  it('offers no Reissue for an app whose claim code was already redeemed', async () => {
    installFetch({ provisions: { body: { isOperator: true, provisions: [claimed, unclaimed] } } });
    await renderVisible();

    const rows = await screen.findAllByTestId('provisioned-app');
    expect(rows.map((row) => row.getAttribute('data-slug'))).toEqual(['dykil', 'learn']);
    expect(rows[0].textContent).toContain('claimed');
    expect(rows[0].textContent).not.toContain('Reissue');
    expect(screen.getAllByTestId('provisioned-app-reissue')).toHaveLength(1);
  });

  it('Reissue raises the reissueClaim proposal for that slug and follows it to approval', async () => {
    const callbacks = installIntervalSpy();
    const { spy, state } = installFetch({
      provisions: { body: { isOperator: true, provisions: [unclaimed] } },
      post: { status: 201, body: { status: 'pending', proposalId: 'appprov_reissue' } },
      approvals: [{ proposalId: 'appprov_reissue', status: 'pending' }],
    });
    await renderVisible();

    await act(async () => {
      fireEvent.click(await screen.findByTestId('provisioned-app-reissue'));
    });

    const calls = postCalls(spy);
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual({ slug: 'learn', displayName: 'learn', reissueClaim: true });
    expect((await screen.findByTestId('provision-proposal-id')).textContent).toBe('appprov_reissue');
    expect(screen.getByText('Reissue proposed')).toBeDefined();

    // Approving the reissue card ends the tracking; the code itself shows in the approvals card.
    state.approvals = [{ proposalId: 'appprov_reissue', status: 'approved' }];
    await tick(callbacks);
    await waitFor(() => expect(screen.getByTestId('provision-result').getAttribute('data-phase')).toBe('reissued'));
    expect(screen.getByText(/one-time claim code for learn is in the amber box/)).toBeDefined();
  });

  it('shows the server refusal and keeps the list when the reissue is rejected', async () => {
    installFetch({
      provisions: { body: { isOperator: true, provisions: [unclaimed] } },
      post: { ok: false, status: 409, body: { error: 'nothing to reissue for learn' } },
    });
    await renderVisible();

    await act(async () => {
      fireEvent.click(await screen.findByTestId('provisioned-app-reissue'));
    });

    expect(await screen.findByText('nothing to reissue for learn')).toBeDefined();
    expect(screen.queryByTestId('provision-result')).toBeNull();
    expect(screen.getByTestId('provisioned-app')).toBeDefined();
  });

  it('refreshes the list once a followed provision succeeds', async () => {
    const callbacks = installIntervalSpy();
    const { state } = installFetch({ approvals: [{ proposalId: 'appprov_1', status: 'pending' }] });
    await renderVisible();
    await proposeCoffee();
    expect(screen.queryByTestId('provisioned-apps')).toBeNull();

    state.approvals = [{ proposalId: 'appprov_1', status: 'applied' }];
    state.ledger = {
      status: 200,
      body: { slug: 'coffee', status: 'succeeded', appDid: 'did:imajin:coffee', repoUrl: 'https://github.com/ima-jin/coffee', failedStep: null, errorMessage: null },
    };
    state.provisions = {
      body: { isOperator: true, provisions: [{ slug: 'coffee', appDid: 'did:imajin:coffee', repoUrl: 'https://github.com/ima-jin/coffee', claimed: false }] },
    };
    await tick(callbacks);

    const row = await screen.findByTestId('provisioned-app');
    expect(row.getAttribute('data-slug')).toBe('coffee');
  });

  it.each([
    ['the list read is refused', { ok: false, status: 500, body: {} }],
    ['the list has no provisions key', { body: { isOperator: true } }],
  ])('renders no list and keeps the form usable when %s', async (_label, provisions) => {
    installFetch({ provisions });
    await renderVisible();
    await act(async () => {});

    expect(screen.queryByTestId('provisioned-apps')).toBeNull();
    expect(screen.getByRole('button', { name: 'Propose provision' })).toBeDefined();
  });

  it('renders no list when the list read throws', async () => {
    const { spy } = installFetch();
    const base = spy.getMockImplementation()!;
    spy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === PROVISIONED_APPS_URL) throw new Error('offline');
      return base(url, init);
    });
    await renderVisible();
    await act(async () => {});

    expect(screen.queryByTestId('provisioned-apps')).toBeNull();
  });

  it('does not read the list for a non-operator', async () => {
    const { spy } = installFetch({ isOperator: false });
    render(<ProvisionAppPanel />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await act(async () => {});

    expect(spy.mock.calls.some(([url]) => url === PROVISIONED_APPS_URL)).toBe(false);
  });
});
