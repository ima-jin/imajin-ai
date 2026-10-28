// @vitest-environment jsdom
/**
 * Smoke-render test for `JinPage` (default export). #2293 folded the
 * legacy inline GitHub proposal table into `OperatorApprovalsPanel`, so
 * this test only needs to confirm the page mounts its panel composition
 * (header + Vault/Access/OperatorApprovals/UsageFeed panels) without
 * throwing — per-panel behavior is covered by each panel's own test file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { installIntervalSpy } from './panel-test-support';

// The nested UsageFeedPanel calls `useSearchParams`, which needs a Next
// router context that does not exist outside the app runtime.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const { default: JinPage } = await import('../page');

function installFetch() {
  const spy = vi.fn(async (url: string) => {
    if (url === '/jin/api/app-secrets') return new Response(null, { status: 403 });
    if (url.startsWith('/jin/api/events?')) return Response.json({ events: [], total: 0, limit: 50, offset: 0 });
    return { ok: true, status: 200, json: async () => ({ isOperator: false, approvals: [], entries: [] }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JinPage', () => {
  function installActingInbox() {
    localStorage.setItem('imajin:acting-as', 'did:imajin:org');
    const card = {
      proposalId: 'restart-personal', source: 'system-agent', kind: 'system-agent:restart',
      summary: 'Personal gateway restart', status: 'pending', keysTouched: [],
      detail: null, decision: null, createdAt: new Date().toISOString(),
    };
    let pending = 0;
    let approved = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      let data: object = { isOperator: false, approvals: [], entries: [] };
      if (url.startsWith('/jin/api/events?')) {
        const org = Boolean(localStorage.getItem('imajin:acting-as'));
        return Response.json({ events: [{
          id: org ? 'org-record' : 'personal-record', kind: 'person',
          who: org ? 'did:imajin:org-record-actor' : 'did:imajin:personal-record-actor',
          action: 'test.event', service: 'kernel', createdAt: '2026-10-21T00:00:00Z',
        }], total: 1, limit: 50, offset: 0 });
      }
      if (url === '/auth/api/session/act-as') {
        expect(JSON.parse(String(init?.body))).toEqual({ did: null });
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === '/jin/api/operator-approvals/restart-personal/decision') {
        expect(localStorage.getItem('imajin:acting-as')).toBeNull();
        expect(JSON.parse(String(init?.body))).toEqual({ decision: 'approve' });
        approved = true;
      }
      if (url === '/jin/api/operator-approvals?view=acting') {
        data = localStorage.getItem('imajin:acting-as') ? {
          isOperator: true, approvals: [],
          actAs: { sessionDid: 'did:imajin:ryan', actingDid: 'did:imajin:org' },
          personalInbox: { pending, handle: 'ryan' },
        } : { isOperator: true, actAs: null, approvals: [{ ...card, status: approved ? 'approved' : 'pending' }] };
      }
      return { ok: true, json: async () => data } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, setPending: (value: number) => { pending = value; } };
  }

  it('polls personal attention while keeping org cards isolated, switches once, lands on and approves the personal card', async () => {
    const timers = installIntervalSpy();
    const fixture = installActingInbox();
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    render(<JinPage />);
    await screen.findByText('Inbox');
    expect(await screen.findByText('did:imajin:org-record-actor')).toBeDefined();
    expect(screen.queryByText('did:imajin:personal-record-actor')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch back' })).toBeNull();
    fixture.setPending(2);
    await act(async () => { timers.forEach(tick => tick()); });
    const button = await screen.findByRole('button', { name: 'Switch back' });
    expect(screen.getByRole('status').textContent).toContain('2 approvals waiting for you as @ryan');
    expect(screen.queryByText('Personal gateway restart')).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText('did:imajin:personal-record-actor')).toBeDefined();
    expect(screen.queryByText('did:imajin:org-record-actor')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText('approved — pending apply');
    expect(fixture.fetchMock.mock.calls.filter(([url]) => url === '/auth/api/session/act-as')).toHaveLength(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(screen.queryByRole('button', { name: 'Switch back' })).toBeNull();
    expect(document.cookie).not.toContain('x-acting-as=');
  });

  it.each(['http', 'network'])('keeps the acting identity and banner when switch fails (%s)', async failure => {
    const fixture = installActingInbox();
    fixture.setPending(1);
    render(<JinPage />);
    const button = await screen.findByRole('button', { name: 'Switch back' });
    expect(screen.getByRole('status').textContent).toContain('1 approval waiting');
    if (failure === 'http') fixture.fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    else fixture.fetchMock.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(button);
    await screen.findByText('Could not switch back. Try again.');
    expect(localStorage.getItem('imajin:acting-as')).toBe('did:imajin:org');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });
  it('renders the header and mounts without throwing', async () => {
    installFetch();

    render(<JinPage />);

    expect(await screen.findByText('/jin')).toBeDefined();
    expect(screen.getByText('Pending proposals — human approval surface')).toBeDefined();
  });
});
