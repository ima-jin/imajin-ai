// @vitest-environment jsdom
/**
 * Component tests for the /jin delegate-grant bearers panel (#2252):
 * visibility gating, bearer list rendering (empty/populated, active vs.
 * revoked), the "Issue a static bearer" form (#2367: scope toggles from the
 * connector vocabulary, keypair copy, POST body, approval-card hand-off,
 * success/error flash), the revoke action, and poll refresh.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { AccessBearersPanel } from '../access-bearers-panel';
import { scopesForSurface } from '@imajin/auth/scope-vocabulary';
import { approvalCardAnchorId, APPROVALS_REFRESH_EVENT } from '../approval-anchor';
import { installIntervalSpy } from './panel-test-support';

interface BearerFixture {
  bearerId: string;
  clientLabel: string;
  purpose: string;
  scopes: string[];
  surfaces: string[];
  status: string;
  issuedAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  hardCapAt: string;
}

function bearer(overrides: Partial<BearerFixture> = {}): BearerFixture {
  return {
    bearerId: 'dgb_1',
    clientLabel: 'Muse Code',
    purpose: 'read my media',
    scopes: ['discovery:read'],
    surfaces: ['mcp'],
    status: 'active',
    issuedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: '2026-04-01T00:00:00.000Z',
    hardCapAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function installFetch(options: {
  bearersResponse?: { bearers: BearerFixture[] } | null;
  knockResponse?: { ok: boolean; status?: number; body?: unknown };
  revokeResponse?: { ok: boolean; status?: number; body?: unknown };
}) {
  const {
    bearersResponse = { bearers: [] },
    knockResponse = { ok: true, body: { requestId: 'dgr_1', proposalId: 'aprop_1', expiresAt: '2026-01-02T00:00:00.000Z' } },
    revokeResponse = { ok: true, body: { ok: true, status: 'revoked' } },
  } = options;

  const spy = vi.fn((url: string) => {
    if (url.includes('/knock')) {
      return Promise.resolve({
        ok: knockResponse.ok,
        status: knockResponse.status ?? (knockResponse.ok ? 201 : 400),
        json: async () => knockResponse.body ?? {},
      } as unknown as Response);
    }
    if (url.includes('/revoke')) {
      return Promise.resolve({
        ok: revokeResponse.ok,
        status: revokeResponse.status ?? (revokeResponse.ok ? 200 : 400),
        json: async () => revokeResponse.body ?? {},
      } as unknown as Response);
    }
    if (bearersResponse === null) {
      return Promise.resolve({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => bearersResponse } as unknown as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('visibility', () => {
  it('renders nothing when the bearers endpoint is unauthorized (signed out)', async () => {
    const spy = installFetch({ bearersResponse: null });
    const { container } = render(<AccessBearersPanel />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders the panel header once the bearers endpoint succeeds', async () => {
    installFetch({});
    render(<AccessBearersPanel />);

    expect(await screen.findByText('Delegate-grant bearers')).toBeDefined();
  });
});

describe('bearer list rendering', () => {
  it('shows an empty-state message when there are no bearers yet', async () => {
    installFetch({});
    render(<AccessBearersPanel />);

    expect(await screen.findByText('No delegate-grant bearers yet.')).toBeDefined();
  });

  it('renders every field of an active bearer, including "never" for an unused one', async () => {
    installFetch({ bearersResponse: { bearers: [bearer()] } });
    render(<AccessBearersPanel />);

    const card = await screen.findByTestId('access-bearer-card');
    expect(within(card).getByText('Muse Code')).toBeDefined();
    expect(within(card).getByText('active')).toBeDefined();
    expect(within(card).getByText('read my media')).toBeDefined();
    expect(within(card).getByText('discovery:read')).toBeDefined();
    expect(within(card).getByText('mcp')).toBeDefined();
    expect(within(card).getByText('never')).toBeDefined();
    expect(within(card).getByRole('button', { name: 'Revoke' })).toBeDefined();
  });

  it('renders lastUsedAt when present and hides the Revoke button for a revoked bearer', async () => {
    const revoked = bearer({ bearerId: 'dgb_2', status: 'revoked', lastUsedAt: '2026-02-01T00:00:00.000Z' });
    installFetch({ bearersResponse: { bearers: [revoked] } });
    render(<AccessBearersPanel />);

    await screen.findByTestId('access-bearer-card');
    expect(screen.getByText('revoked')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.queryByText('never')).toBeNull();
  });

  it('renders one card per bearer', async () => {
    installFetch({
      bearersResponse: {
        bearers: [bearer({ bearerId: 'dgb_1', clientLabel: 'Muse Code' }), bearer({ bearerId: 'dgb_2', clientLabel: 'Muse App' })],
      },
    });
    render(<AccessBearersPanel />);

    expect(await screen.findAllByTestId('access-bearer-card')).toHaveLength(2);
    expect(screen.getByText('Muse Code')).toBeDefined();
    expect(screen.getByText('Muse App')).toBeDefined();
  });
});

function fillBasics(label = 'Muse Code', purpose = 'read my media') {
  fireEvent.change(screen.getByLabelText('Client label'), { target: { value: label } });
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: purpose } });
}

function sentKnockBody(spy: ReturnType<typeof installFetch>) {
  const knockCall = spy.mock.calls.find(([url]) => String(url).includes('/knock'));
  return JSON.parse((knockCall?.[1] as { body: string }).body) as {
    clientLabel: string;
    purpose: string;
    scopes: string[];
    surfaces: string[];
    slidingWindowDays: number;
  };
}

describe('issue a static bearer form', () => {
  it('explains in plain copy that this is for clients that cannot hold an Imajin keypair', async () => {
    installFetch({});
    render(<AccessBearersPanel />);

    expect(await screen.findByRole('heading', { name: 'Issue a static bearer' })).toBeDefined();
    const note = screen.getByTestId('static-bearer-scope-note');
    expect(note.textContent).toContain('cannot hold an Imajin keypair');
    expect(note.textContent).toContain('app.authorized');
  });

  it('offers one toggle per scope in the MCP connector vocabulary, none pre-selected', async () => {
    installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    const expected = scopesForSurface('mcp');
    expect(expected.length).toBeGreaterThan(0);
    const scopeGroup = screen.getByRole('group', { name: /Scopes/ });
    const boxes = within(scopeGroup).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(expected.length);
    expect(boxes.every((box) => !box.checked)).toBe(true);
    for (const scope of expected) expect(within(scopeGroup).getByText(scope)).toBeDefined();
  });

  it('keeps the submit button disabled until at least one scope is toggled on', async () => {
    installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    const submit = screen.getByRole('button', { name: 'Request bearer' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const scopeGroup = screen.getByRole('group', { name: /Scopes/ });
    const [first] = within(scopeGroup).getAllByRole('checkbox');
    fireEvent.click(first!);
    expect(submit.disabled).toBe(false);

    fireEvent.click(first!);
    expect(submit.disabled).toBe(true);
  });

  it('disables submit when the only surface is toggled off', async () => {
    installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fireEvent.click(within(screen.getByRole('group', { name: /Scopes/ })).getAllByRole('checkbox')[0]!);
    const submit = screen.getByRole('button', { name: 'Request bearer' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    fireEvent.click(within(screen.getByRole('group', { name: 'Surfaces' })).getByRole('checkbox', { name: 'mcp' }));
    expect(submit.disabled).toBe(true);
  });

  it('POSTs the knock with the toggled scopes, surface and sliding window', async () => {
    const spy = installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fillBasics('  Muse Code ', ' read my media ');
    fireEvent.click(screen.getByRole('checkbox', { name: /discovery:read/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /corpus:read/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request bearer' }));

    await waitFor(() => expect(screen.getByText(/Request sent — approve it below/)).toBeDefined());
    expect(sentKnockBody(spy)).toEqual({
      clientLabel: 'Muse Code',
      purpose: 'read my media',
      scopes: ['discovery:read', 'corpus:read'],
      surfaces: ['mcp'],
      slidingWindowDays: 30,
    });
  });

  it('defaults the sliding window to 90 days', async () => {
    const spy = installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: /discovery:read/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Request bearer' }));

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('/knock'))).toBe(true));
    expect(sentKnockBody(spy).slidingWindowDays).toBe(90);
  });

  it('hands off to the approval card: shows the proposal link, refreshes the queue, resets the form', async () => {
    installFetch({});
    const refresh = vi.fn();
    globalThis.addEventListener(APPROVALS_REFRESH_EVENT, refresh);
    try {
      render(<AccessBearersPanel />);
      await screen.findByText('Delegate-grant bearers');

      fillBasics();
      fireEvent.click(screen.getByRole('checkbox', { name: /discovery:read/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Request bearer' }));

      const handoff = await screen.findByTestId('knock-handoff');
      expect(within(handoff).getByTestId('knock-proposal-id').textContent).toBe('aprop_1');
      const link = within(handoff).getByRole('link', { name: /review it in Operator approvals/ });
      expect(link.getAttribute('href')).toBe(`#${approvalCardAnchorId('aprop_1')}`);
      expect(handoff.textContent).toContain('never shown again');
      expect(refresh).toHaveBeenCalledTimes(1);

      expect((screen.getByLabelText('Client label') as HTMLInputElement).value).toBe('');
      expect((screen.getByRole('checkbox', { name: /discovery:read/ }) as HTMLInputElement).checked).toBe(false);

      fireEvent.click(within(handoff).getByRole('button', { name: 'dismiss' }));
      expect(screen.queryByTestId('knock-handoff')).toBeNull();
    } finally {
      globalThis.removeEventListener(APPROVALS_REFRESH_EVENT, refresh);
    }
  });

  it('never renders a bearer secret — the response carries none and the panel shows only metadata', async () => {
    installFetch({ bearersResponse: { bearers: [bearer()] } });
    const { container } = render(<AccessBearersPanel />);
    await screen.findByTestId('access-bearer-card');

    expect(container.querySelector('pre')).toBeNull();
    expect(screen.queryByRole('button', { name: /copy|reveal/i })).toBeNull();
  });

  it('shows the server error, keeps the typed values and does not hand off when the knock fails', async () => {
    installFetch({ knockResponse: { ok: false, status: 400, body: { error: 'clientLabel is required' } } });
    const refresh = vi.fn();
    globalThis.addEventListener(APPROVALS_REFRESH_EVENT, refresh);
    try {
      render(<AccessBearersPanel />);
      await screen.findByText('Delegate-grant bearers');

      fillBasics('x', 'x');
      fireEvent.click(screen.getByRole('checkbox', { name: /discovery:read/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Request bearer' }));

      expect(await screen.findByText('clientLabel is required')).toBeDefined();
      expect(screen.queryByTestId('knock-handoff')).toBeNull();
      expect(refresh).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Client label') as HTMLInputElement).value).toBe('x');
      expect((screen.getByRole('checkbox', { name: /discovery:read/ }) as HTMLInputElement).checked).toBe(true);
    } finally {
      globalThis.removeEventListener(APPROVALS_REFRESH_EVENT, refresh);
    }
  });

  it('falls back to a generic message when the failed knock has no error body', async () => {
    installFetch({ knockResponse: { ok: false, status: 503 } });
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: /discovery:read/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Request bearer' }));

    expect(await screen.findByText('Knock failed (503)')).toBeDefined();
  });

  it('reports a network error without handing off', async () => {
    const spy = installFetch({});
    spy.mockImplementation((url: string) => {
      if (String(url).includes('/knock')) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ bearers: [] }) } as unknown as Response);
    });
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: /discovery:read/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Request bearer' }));

    expect(await screen.findByText(/Network error/)).toBeDefined();
    expect(screen.queryByTestId('knock-handoff')).toBeNull();
  });

  it('still hands off cleanly when the success response has no proposalId', async () => {
    installFetch({ knockResponse: { ok: true, body: { requestId: 'dgr_1' } } });
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: /discovery:read/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Request bearer' }));

    await waitFor(() => expect(screen.getByText(/Request sent — approve it below/)).toBeDefined());
    expect(screen.queryByTestId('knock-handoff')).toBeNull();
  });
});

describe('revoke action', () => {
  it('revokes a bearer and refreshes the list', async () => {
    const spy = installFetch({ bearersResponse: { bearers: [bearer()] } });
    render(<AccessBearersPanel />);
    await screen.findByTestId('access-bearer-card');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.getByText('Bearer revoked — immediate effect.')).toBeDefined());
    expect(spy.mock.calls.some(([url]) => String(url).includes('/bearers/dgb_1/revoke'))).toBe(true);
  });

  it('shows the server error message when revoke fails', async () => {
    installFetch({
      bearersResponse: { bearers: [bearer()] },
      revokeResponse: { ok: false, status: 404, body: { error: 'Bearer not found' } },
    });
    render(<AccessBearersPanel />);
    await screen.findByTestId('access-bearer-card');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Bearer not found')).toBeDefined();
  });
});

describe('poll refresh', () => {
  it('registers a poll interval and silently refetches on each tick', async () => {
    const callbacks = installIntervalSpy();
    const spy = installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');
    expect(spy).toHaveBeenCalledTimes(1);

    callbacks[0]!();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('manually refreshes when the refresh button is clicked', async () => {
    const spy = installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');
    expect(spy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /refresh/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
