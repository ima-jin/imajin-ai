// @vitest-environment jsdom
/**
 * Component tests for the /jin Grants lane panel (#2292): operator gate,
 * normalization rendering across sources, one-tap revoke calling the right
 * route per source with a confirm step, the "show revoked" tombstone
 * filter, and poll refresh.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { GrantsPanel } from '../grants-panel';
import { installIntervalSpy } from './panel-test-support';

interface GrantCardFixture {
  id: string;
  source: 'auth-grant' | 'auth-membership' | 'vault-delegation' | 'access-bearer' | 'app-authorization';
  grantee: string;
  capabilities: string[];
  issuedAt: string | null;
  lastUsedAt: string | null;
  ackState: 'used' | 'failed' | 'discarded' | 'pending' | null;
  ackEvidence: { kind?: string; ref?: string; note?: string } | null;
  status: string;
  revocable: boolean;
  revoke: { method: 'DELETE' | 'POST'; path: string; body?: Record<string, unknown> } | null;
}

function grant(overrides: Partial<GrantCardFixture> = {}): GrantCardFixture {
  return {
    id: 'auth-grant:grant_1',
    source: 'auth-grant',
    grantee: 'did:imajin:agent1',
    capabilities: ['messages:write'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    ackState: null,
    ackEvidence: null,
    status: 'active',
    revocable: true,
    revoke: { method: 'DELETE', path: '/auth/api/grants/grant_1' },
    ...overrides,
  };
}

function installFetch(options: {
  grantsResponse?: { isOperator: boolean; grants: GrantCardFixture[] } | null;
  revokeResponse?: { ok: boolean; status?: number; body?: unknown };
}) {
  const {
    grantsResponse = { isOperator: true, grants: [] },
    revokeResponse = { ok: true, body: { ok: true } },
  } = options;

  const spy = vi.fn((url: string) => {
    if (url.includes('/jin/api/grants')) {
      if (grantsResponse === null) {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => grantsResponse } as unknown as Response);
    }
    // Any revoke call — matched by path, not by method, since different
    // sources use DELETE or POST.
    return Promise.resolve({
      ok: revokeResponse.ok,
      status: revokeResponse.status ?? (revokeResponse.ok ? 200 : 400),
      json: async () => revokeResponse.body ?? {},
    } as unknown as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('operator gate', () => {
  it('renders nothing for a non-operator identity', async () => {
    const spy = installFetch({ grantsResponse: { isOperator: false, grants: [] } });
    const { container } = render(<GrantsPanel />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders the panel header for the operator identity', async () => {
    installFetch({ grantsResponse: { isOperator: true, grants: [] } });
    render(<GrantsPanel />);

    expect(await screen.findByText('Grants')).toBeDefined();
  });
});

describe('normalization rendering', () => {
  it('renders one card per grant, with source label, grantee, capabilities, and status', async () => {
    installFetch({
      grantsResponse: {
        isOperator: true,
        grants: [
          grant({ id: 'access-bearer:dgb_1', source: 'access-bearer', grantee: 'Muse Code', capabilities: ['discovery:read'] }),
        ],
      },
    });
    render(<GrantsPanel />);

    const card = await screen.findByTestId('grant-card');
    expect(within(card).getByText('Delegate-grant bearer')).toBeDefined();
    expect(within(card).getByText('Muse Code')).toBeDefined();
    expect(within(card).getByText('discovery:read')).toBeDefined();
    expect(within(card).getByText('active')).toBeDefined();
  });

  it('shows an ack-state badge and evidence on expand for vault-delegation grants', async () => {
    installFetch({
      grantsResponse: {
        isOperator: true,
        grants: [
          grant({
            id: 'vault-delegation:vdg_1',
            source: 'vault-delegation',
            grantee: 'did:imajin:consumer1',
            ackState: 'failed',
            ackEvidence: { kind: 'http', ref: '500', note: 'timed out' },
            revoke: { method: 'POST', path: '/api/vault/delegation/revoke', body: { field: 'vault-minted-key:did:imajin:vaultkey1' } },
          }),
        ],
      },
    });
    render(<GrantsPanel />);

    const badge = await screen.findByText(/failed/);
    expect(screen.queryByTestId('ack-evidence')).toBeNull();

    fireEvent.click(badge);
    expect(await screen.findByTestId('ack-evidence')).toBeDefined();
    expect(screen.getByText(/timed out/)).toBeDefined();
  });

  it('hides the Revoke button for a non-revocable card', async () => {
    installFetch({
      // 'expired' rather than 'revoked' — the panel filters out revoked
      // cards by default (see the "show revoked filter" suite below), which
      // would hide this fixture for an unrelated reason.
      grantsResponse: { isOperator: true, grants: [grant({ revocable: false, revoke: null, status: 'expired' })] },
    });
    render(<GrantsPanel />);

    await screen.findByTestId('grant-card');
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});

describe('revoke action', () => {
  it('requires a confirm step, then calls the card\u2019s own revoke route and refreshes', async () => {
    const spy = installFetch({
      grantsResponse: {
        isOperator: true,
        grants: [grant({ id: 'auth-grant:grant_1', revoke: { method: 'DELETE', path: '/auth/api/grants/grant_1' } })],
      },
    });
    render(<GrantsPanel />);
    await screen.findByTestId('grant-card');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText('Revoke this grant?')).toBeDefined();
    // Not yet called for the revoke path — only the confirm UI appeared.
    expect(spy.mock.calls.some(([url]) => String(url).includes('/auth/api/grants/grant_1'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke' }));

    await waitFor(() => expect(screen.getByText('Grant revoked.')).toBeDefined());
    const revokeCall = spy.mock.calls.find(([url]) => String(url).includes('/auth/api/grants/grant_1'));
    expect(revokeCall).toBeDefined();
    expect((revokeCall?.[1] as { method: string }).method).toBe('DELETE');
  });

  it('calls the vault revoke route with its field body for a vault-delegation card', async () => {
    const spy = installFetch({
      grantsResponse: {
        isOperator: true,
        grants: [
          grant({
            id: 'vault-delegation:vdg_1',
            source: 'vault-delegation',
            revoke: { method: 'POST', path: '/api/vault/delegation/revoke', body: { field: 'vault-minted-key:did:imajin:vaultkey1' } },
          }),
        ],
      },
    });
    render(<GrantsPanel />);
    await screen.findByTestId('grant-card');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke' }));

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('/api/vault/delegation/revoke'))).toBe(true));
    const revokeCall = spy.mock.calls.find(([url]) => String(url).includes('/api/vault/delegation/revoke'));
    const sentBody = JSON.parse((revokeCall?.[1] as { body: string }).body) as { field: string };
    expect(sentBody).toEqual({ field: 'vault-minted-key:did:imajin:vaultkey1' });
    expect((revokeCall?.[1] as { method: string }).method).toBe('POST');
  });

  it('cancel dismisses the confirm step without calling the revoke route', async () => {
    const spy = installFetch({ grantsResponse: { isOperator: true, grants: [grant()] } });
    render(<GrantsPanel />);
    await screen.findByTestId('grant-card');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Revoke this grant?')).toBeNull();
    expect(spy.mock.calls.some(([url]) => String(url).includes('/auth/api/grants/'))).toBe(false);
  });

  it('shows the server error message when revoke fails', async () => {
    installFetch({
      grantsResponse: { isOperator: true, grants: [grant()] },
      revokeResponse: { ok: false, status: 404, body: { error: 'Grant not found' } },
    });
    render(<GrantsPanel />);
    await screen.findByTestId('grant-card');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke' }));

    expect(await screen.findByText('Grant not found')).toBeDefined();
  });
});

describe('show revoked filter', () => {
  it('hides revoked cards by default and reveals them via the toggle', async () => {
    installFetch({
      grantsResponse: {
        isOperator: true,
        grants: [
          grant({ id: 'auth-grant:active', status: 'active' }),
          grant({ id: 'auth-grant:revoked', status: 'revoked', revocable: false, revoke: null }),
        ],
      },
    });
    render(<GrantsPanel />);

    await screen.findAllByTestId('grant-card');
    expect(screen.getAllByTestId('grant-card')).toHaveLength(1);

    fireEvent.click(screen.getByRole('checkbox', { name: /show revoked/ }));

    await waitFor(() => expect(screen.getAllByTestId('grant-card')).toHaveLength(2));
  });
});

describe('poll refresh', () => {
  it('registers a poll interval and silently refetches on each tick', async () => {
    const callbacks = installIntervalSpy();
    const spy = installFetch({});
    render(<GrantsPanel />);
    await screen.findByText('Grants');
    expect(spy).toHaveBeenCalledTimes(1);

    callbacks[0]!();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
