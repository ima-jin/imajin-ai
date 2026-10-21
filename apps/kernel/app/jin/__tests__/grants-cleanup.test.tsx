// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { GrantsPanel } from '../grants-panel';
import type { GrantCard } from '@/src/lib/jin/grants-lane';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function duplicates(overrides: Partial<GrantCard> = {}): GrantCard {
  return {
    id: 'app-authorization:newest', source: 'app-authorization', grantee: 'Karaoke',
    appDid: 'did:imajin:karaoke', surplusGrantIds: ['old-a', 'old-b'],
    revoke: { method: 'POST', path: '/api/auth/revoke', body: { attestationId: 'newest' } },
    capabilities: ['profile:read'], issuedAt: '2026-10-20T10:00:00.000Z',
    lastUsedAt: null, ackState: null, ackEvidence: null, status: 'active', revocable: true,
    ...overrides,
  };
}

function installCleanupTransport(options: {
  card?: GrantCard;
  failures?: Record<string, number | 'network'>;
  refreshFailure?: boolean;
} = {}) {
  const card = options.card ?? duplicates();
  const remaining = new Set(card.surplusGrantIds);
  let reads = 0;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/jin/api/grants') {
      reads += 1;
      if (reads > 1 && options.refreshFailure) throw new Error('offline');
      return {
        ok: true, status: 200,
        json: async () => ({
          isOperator: true,
          grants: [{ ...card, surplusGrantIds: [...remaining] }],
        }),
      } as Response;
    }
    const { attestationId } = JSON.parse(String(init?.body)) as { attestationId: string };
    const outcome = options.failures?.[attestationId] ?? 200;
    if (outcome === 'network') throw new Error('offline');
    if (outcome < 300 || outcome === 409) remaining.delete(attestationId);
    return { ok: outcome < 300, status: outcome, json: async () => ({ error: 'fixture failure' }) } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('duplicate app grant cleanup (#3008)', () => {
  it('one tap posts exactly nine surplus ids, keeps newest, and returns to single-grant rendering', async () => {
    const older = Array.from({ length: 9 }, (_, i) => `old-${i}`);
    const spy = installCleanupTransport({ card: duplicates({ surplusGrantIds: older }) });
    render(<GrantsPanel />);
    expect(await screen.findByText('Karaoke · 10 live grants · keep newest, revoke 9')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke 9 older grants' }));

    expect(await screen.findByText('Older grants revoked. Newest kept.')).toBeDefined();
    const calls = spy.mock.calls.filter(([input]) => input === '/api/auth/revoke');
    expect(calls).toHaveLength(9);
    expect(calls.map(([, init]) => JSON.parse(String(init?.body)).attestationId)).toEqual(older);
    for (const [, init] of calls) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    }
    expect(screen.queryByText(/live grants/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDefined();
    expect(screen.getByTestId('grant-card').className).toBe('rounded-lg border border-gray-800 p-4 space-y-2');
    expect(screen.getByRole('button', { name: 'Revoke' }).className)
      .toBe('px-2.5 py-1 rounded text-xs font-medium bg-red-900/40 text-red-300 hover:bg-red-800/60');
    expect(spy.mock.calls.filter(([input]) => input === '/jin/api/grants')).toHaveLength(2);
  });

  it('treats already-revoked 409 as safe and still revokes other surplus', async () => {
    const spy = installCleanupTransport({ failures: { 'old-a': 409 } });
    render(<GrantsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke 2 older grants' }));
    expect(await screen.findByText('Older grants revoked. Newest kept.')).toBeDefined();
    expect(spy.mock.calls.filter(([input]) => input === '/api/auth/revoke')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([403, 500, 'network'] as const)('refreshes after partial %s failure and retries only remaining surplus', async failure => {
    const spy = installCleanupTransport({ failures: { 'old-a': failure } });
    render(<GrantsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke 2 older grants' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent',
      '1 of 2 older grants could not be confirmed revoked. Newest kept. Grants refreshed; retry remaining older grants.');
    expect(screen.getByText('Karaoke · 2 live grants · keep newest, revoke 1')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke 1 older grant' }));
    await waitFor(() => expect(spy.mock.calls.filter(([input]) => input === '/api/auth/revoke')).toHaveLength(3));
    const sentIds = spy.mock.calls.filter(([input]) => input === '/api/auth/revoke')
      .map(([, init]) => JSON.parse(String(init?.body)).attestationId);
    expect(sentIds).toEqual(['old-a', 'old-b', 'old-a']);
  });

  it('reports total network failure without an unhandled rejection and refreshes', async () => {
    const spy = installCleanupTransport({ failures: { 'old-a': 'network', 'old-b': 'network' } });
    render(<GrantsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke 2 older grants' }));
    expect((await screen.findByRole('alert')).textContent).toContain('2 of 2 older grants could not be confirmed revoked');
    expect(spy.mock.calls.filter(([input]) => input === '/jin/api/grants')).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Revoke 2 older grants' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('warns when cleanup succeeds but the refresh cannot be confirmed', async () => {
    installCleanupTransport({ refreshFailure: true });
    render(<GrantsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke 2 older grants' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh grants');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports partial failure and failed refresh together without claiming success', async () => {
    installCleanupTransport({ failures: { 'old-a': 'network' }, refreshFailure: true });
    render(<GrantsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke 2 older grants' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      '1 of 2 older grants could not be confirmed revoked. Newest kept. Refresh failed; refresh before retrying.');
  });

  it('preserves the single-app confirmation flow and refreshes after a network failure', async () => {
    const spy = installCleanupTransport({
      card: duplicates({ surplusGrantIds: [] }), failures: { newest: 'network' },
    });
    render(<GrantsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(spy.mock.calls.filter(([input]) => input === '/api/auth/revoke')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke' }));
    expect((await screen.findByRole('alert')).textContent).toContain('network error');
    expect(spy.mock.calls.filter(([input]) => input === '/jin/api/grants')).toHaveLength(2);
  });

  it('guards rapid repeated taps and excludes survivor and duplicate ids defensively', async () => {
    let finish!: (response: Response) => void;
    const card = duplicates({ surplusGrantIds: ['newest', 'old-a', 'old-a'] });
    const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === '/jin/api/grants') return { ok: true, json: async () => ({ isOperator: true, grants: [card] }) } as Response;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    render(<GrantsPanel transport={spy} />);
    const button = await screen.findByRole('button', { name: 'Revoke 1 older grant' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const calls = spy.mock.calls.filter(([input]) => input === '/api/auth/revoke');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ attestationId: 'old-a' });
    finish({ ok: true, status: 200 } as Response);
    expect(await screen.findByText('Older grants revoked. Newest kept.')).toBeDefined();
  });

  it.each([
    { source: 'auth-grant' as const },
    { status: 'expired', revocable: false, revoke: null },
    { appDid: undefined },
    { surplusGrantIds: [] },
  ])('does not show cleanup for ineligible data %j', async overrides => {
    installCleanupTransport({ card: duplicates(overrides) });
    render(<GrantsPanel />);
    await screen.findByTestId('grant-card');
    expect(screen.queryByRole('button', { name: /older grant/ })).toBeNull();
    expect(screen.queryByText(/live grants/)).toBeNull();
  });

  it('keeps revoked history separate without cleanup controls in history', async () => {
    const transport = vi.fn(async () => ({
      ok: true, json: async () => ({ isOperator: true, grants: [
        duplicates(),
        duplicates({ id: 'app-authorization:revoked', status: 'revoked', revocable: false, revoke: null }),
      ] }),
    } as Response));
    render(<GrantsPanel transport={transport} />);
    await screen.findByText(/3 live grants/);
    fireEvent.click(screen.getByRole('checkbox', { name: /show revoked/ }));
    expect(screen.getByText('Revoked history')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /older grants/ })).toHaveLength(1);
    expect(screen.getAllByTestId('grant-card')).toHaveLength(2);
  });
});
