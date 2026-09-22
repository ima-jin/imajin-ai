// @vitest-environment jsdom
/**
 * Component tests for the /jin delegate-grant bearers panel (#2252):
 * visibility gating, bearer list rendering (empty/populated, active vs.
 * revoked), the knock form's POST body and success/error flash, the
 * revoke action, and poll refresh.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { AccessBearersPanel } from '../access-bearers-panel';
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

describe('knock form', () => {
  it('submits a knock with comma-separated scopes trimmed into an array', async () => {
    const spy = installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fireEvent.change(screen.getByPlaceholderText(/Client label/), { target: { value: 'Muse Code' } });
    fireEvent.change(screen.getByPlaceholderText(/Purpose/), { target: { value: 'read my media' } });
    fireEvent.change(screen.getByPlaceholderText(/Scopes, comma-separated/), { target: { value: 'discovery:read,  corpus:read ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Knock' }));

    await waitFor(() => expect(screen.getByText(/Knock sent/)).toBeDefined());
    const knockCall = spy.mock.calls.find(([url]) => String(url).includes('/knock'));
    const sentBody = JSON.parse((knockCall?.[1] as { body: string }).body) as {
      clientLabel: string;
      purpose: string;
      scopes: string[];
      surfaces: string[];
      slidingWindowDays: number;
    };
    expect(sentBody).toEqual({
      clientLabel: 'Muse Code',
      purpose: 'read my media',
      scopes: ['discovery:read', 'corpus:read'],
      surfaces: ['mcp'],
      slidingWindowDays: 90,
    });
  });

  it('shows the server error message when the knock request fails', async () => {
    installFetch({ knockResponse: { ok: false, status: 400, body: { error: 'clientLabel is required' } } });
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    fireEvent.change(screen.getByPlaceholderText(/Client label/), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Purpose/), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Scopes, comma-separated/), { target: { value: 'discovery:read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Knock' }));

    expect(await screen.findByText('clientLabel is required')).toBeDefined();
  });

  it('changes the requested surface and sliding window via the selects', async () => {
    const spy = installFetch({});
    render(<AccessBearersPanel />);
    await screen.findByText('Delegate-grant bearers');

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1]!, { target: { value: '30' } });

    fireEvent.change(screen.getByPlaceholderText(/Client label/), { target: { value: 'Muse Code' } });
    fireEvent.change(screen.getByPlaceholderText(/Purpose/), { target: { value: 'p' } });
    fireEvent.change(screen.getByPlaceholderText(/Scopes, comma-separated/), { target: { value: 'discovery:read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Knock' }));

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('/knock'))).toBe(true));
    const knockCall = spy.mock.calls.find(([url]) => String(url).includes('/knock'));
    const sentBody = JSON.parse((knockCall?.[1] as { body: string }).body) as { slidingWindowDays: number };
    expect(sentBody.slidingWindowDays).toBe(30);
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
