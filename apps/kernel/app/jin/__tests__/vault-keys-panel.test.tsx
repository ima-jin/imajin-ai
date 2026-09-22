// @vitest-environment jsdom
/**
 * Component tests for the /jin Vault section (#2247): timeline rendering
 * for every row type, the fetch-without-ack red line, the explicit
 * no-reveal/no-copy-affordance assertion, the hand-provisioned filter, the
 * claim-pending-service stub, and proposal-form submission to
 * `POST /jin/api/vault-proposals`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { VaultKeysPanel } from '../vault-keys-panel';
import { installIntervalSpy } from './panel-test-support';

interface KeyCardFixture {
  did: string;
  publicKey: string;
  purpose: string;
  requestedBy: string;
  mintedBy: string;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  grant: Record<string, unknown> | null;
  timeline: Array<{ type: string; at: string; alert?: boolean; detail: Record<string, unknown> }>;
  heldBy: string | null;
  lastAckAt: string | null;
  fetchWithoutAck: boolean;
}

function keyCard(overrides: Partial<KeyCardFixture> = {}): KeyCardFixture {
  return {
    did: 'did:imajin:abcdef0123456789',
    publicKey: 'a'.repeat(64),
    purpose: 'corpus-identity',
    requestedBy: 'did:imajin:corpus-bootstrap',
    mintedBy: 'did:imajin:operator',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    revokedBy: null,
    grant: null,
    timeline: [
      { type: 'minted', at: '2026-01-01T00:00:00.000Z', detail: { by: 'did:imajin:operator', purpose: 'corpus-identity' } },
    ],
    heldBy: null,
    lastAckAt: null,
    fetchWithoutAck: false,
    ...overrides,
  };
}

function installFetch(options: {
  cardsResponse?: { keys: KeyCardFixture[]; handProvisioned: Array<{ field: string }> } | null;
  proposalResponse?: { ok: boolean; status?: number; body?: unknown };
}) {
  const { cardsResponse = { keys: [], handProvisioned: [] }, proposalResponse = { ok: true, body: { proposalId: 'vprop_1' } } } = options;
  const spy = vi.fn((url: string) => {
    if (url.includes('/vault-proposals')) {
      return Promise.resolve({
        ok: proposalResponse.ok,
        status: proposalResponse.status ?? (proposalResponse.ok ? 201 : 400),
        json: async () => proposalResponse.body ?? {},
      } as unknown as Response);
    }
    if (cardsResponse === null) {
      return Promise.resolve({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => cardsResponse } as unknown as Response);
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
  it('renders nothing when the cards endpoint is unauthorized (non-admin)', async () => {
    const spy = installFetch({ cardsResponse: null });
    const { container } = render(<VaultKeysPanel />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders the Vault header once the cards endpoint succeeds', async () => {
    installFetch({});
    render(<VaultKeysPanel />);

    expect(await screen.findByText('Vault')).toBeDefined();
  });
});

describe('timeline rendering — all row types', () => {
  it('renders minted/granted/fetched/acked/revoked rows for a full-lifecycle card', async () => {
    const card = keyCard({
      status: 'revoked',
      revokedAt: '2026-01-05T00:00:00.000Z',
      revokedBy: 'did:imajin:operator',
      timeline: [
        { type: 'minted', at: '2026-01-01T00:00:00.000Z', detail: { by: 'did:imajin:operator', purpose: 'corpus-identity' } },
        { type: 'granted', at: '2026-01-01T00:01:00.000Z', detail: { to: 'did:imajin:corpus-bootstrap', oneTime: true } },
        { type: 'fetched', at: '2026-01-02T00:00:00.000Z', alert: false, detail: { consumer: 'did:imajin:corpus-bootstrap' } },
        { type: 'acked', at: '2026-01-02T00:05:00.000Z', detail: { outcome: 'used' } },
        { type: 'revoked', at: '2026-01-05T00:00:00.000Z', detail: { by: 'did:imajin:operator' } },
      ],
    });
    installFetch({ cardsResponse: { keys: [card], handProvisioned: [] } });
    render(<VaultKeysPanel />);

    expect(await screen.findByText(/Minted by did:imajin:operator/)).toBeDefined();
    expect(screen.getByText(/Granted to did:imajin:corpus-bootstrap/)).toBeDefined();
    expect(screen.getByText(/Fetched by did:imajin:corpus-bootstrap/)).toBeDefined();
    expect(screen.getByText(/Acked — used/)).toBeDefined();
    expect(screen.getByText(/Revoked by did:imajin:operator/)).toBeDefined();
  });

  it('renders a red-line (alert) fetched row with no matching ack, and no acked row', async () => {
    const card = keyCard({
      grant: { grantedTo: 'did:imajin:corpus-bootstrap' },
      heldBy: 'did:imajin:corpus-bootstrap',
      fetchWithoutAck: true,
      timeline: [
        { type: 'minted', at: '2026-01-01T00:00:00.000Z', detail: { by: 'did:imajin:operator' } },
        { type: 'fetched', at: '2026-01-02T00:00:00.000Z', alert: true, detail: { consumer: 'did:imajin:corpus-bootstrap' } },
      ],
    });
    installFetch({ cardsResponse: { keys: [card], handProvisioned: [] } });
    render(<VaultKeysPanel />);

    const fetchedRow = await screen.findByText(/Fetched by did:imajin:corpus-bootstrap/);
    const row = fetchedRow.closest('li');
    expect(row?.getAttribute('data-alert')).toBe('true');
    expect(screen.getByText('no ack yet')).toBeDefined();
    expect(screen.queryByText(/^Acked/)).toBeNull();
  });

  it('shows the "held in memory by" status line once fetched', async () => {
    const card = keyCard({ heldBy: 'did:imajin:corpus-bootstrap', lastAckAt: new Date(Date.now() - 5 * 60000).toISOString() });
    installFetch({ cardsResponse: { keys: [card], handProvisioned: [] } });
    render(<VaultKeysPanel />);

    expect(await screen.findByText(/held in memory by did:imajin:corpus-bootstrap/)).toBeDefined();
  });

  it('shows "not yet fetched" when the key has no grant activity', async () => {
    installFetch({ cardsResponse: { keys: [keyCard()], handProvisioned: [] } });
    render(<VaultKeysPanel />);

    expect(await screen.findByText('not yet fetched')).toBeDefined();
  });
});

describe('no reveal / no copy affordance (critical invariant)', () => {
  it('never renders a reveal, show, or copy control anywhere on the panel', async () => {
    const card = keyCard({
      grant: { grantedTo: 'did:imajin:corpus-bootstrap' },
      heldBy: 'did:imajin:corpus-bootstrap',
      timeline: [
        { type: 'minted', at: '2026-01-01T00:00:00.000Z', detail: { by: 'did:imajin:operator' } },
        { type: 'granted', at: '2026-01-01T00:01:00.000Z', detail: { to: 'did:imajin:corpus-bootstrap' } },
        { type: 'fetched', at: '2026-01-02T00:00:00.000Z', alert: false, detail: { consumer: 'did:imajin:corpus-bootstrap' } },
        { type: 'acked', at: '2026-01-02T00:05:00.000Z', detail: { outcome: 'used' } },
      ],
    });
    installFetch({ cardsResponse: { keys: [card], handProvisioned: [{ field: 'GH_TOKEN:did:imajin:owner' }] } });
    render(<VaultKeysPanel />);
    await screen.findByTestId('vault-key-card');

    // No interactive control anywhere in the panel offers to reveal, show,
    // unmask, or copy the key material — the entire point of #2247. (The
    // panel's own descriptive copy legitimately says "No reveal, no copy",
    // so this checks CONTROLS — buttons and links — rather than banning the
    // word from the page's text entirely.)
    const interactiveNames = [
      ...screen.getAllByRole('button').map((el) => el.textContent ?? ''),
      ...screen.queryAllByRole('link').map((el) => el.textContent ?? ''),
    ];
    for (const name of interactiveNames) {
      expect(name).not.toMatch(/reveal/i);
      expect(name).not.toMatch(/\bcopy\b/i);
      expect(name).not.toMatch(/\bunmask\b/i);
    }
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    // Never renders the public key or any key-shaped value as text either —
    // only bookkeeping fields (DIDs, timestamps, labels).
    expect(screen.queryByText(card.publicKey)).toBeNull();
  });
});

describe('hand-provisioned filter', () => {
  it('hides the hand-provisioned list until the filter checkbox is checked', async () => {
    installFetch({ cardsResponse: { keys: [], handProvisioned: [{ field: 'GH_TOKEN:did:imajin:owner' }] } });
    render(<VaultKeysPanel />);
    await screen.findByText('Vault');

    expect(screen.queryByTestId('hand-provisioned-list')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: /hand-provisioned/i }));

    expect(await screen.findByTestId('hand-provisioned-list')).toBeDefined();
    expect(screen.getByText('GH_TOKEN:did:imajin:owner')).toBeDefined();
  });

  it('shows an empty-state message when there are no hand-provisioned fields', async () => {
    installFetch({ cardsResponse: { keys: [], handProvisioned: [] } });
    render(<VaultKeysPanel />);
    await screen.findByText('Vault');

    fireEvent.click(screen.getByRole('checkbox', { name: /hand-provisioned/i }));

    expect(await screen.findByText('No hand-provisioned fields found.')).toBeDefined();
  });
});

describe('claim pending service stub (#2243)', () => {
  it('always renders a disabled Claim button referencing #2243', async () => {
    installFetch({});
    render(<VaultKeysPanel />);

    expect(await screen.findByText(/waiting on #2243/)).toBeDefined();
    const claimButton = screen.getByRole('button', { name: 'Claim' }) as HTMLButtonElement;
    expect(claimButton.disabled).toBe(true);
  });
});

describe('mint proposal form', () => {
  it('submits a vault:mint proposal with purpose/requesterDid', async () => {
    const spy = installFetch({});
    render(<VaultKeysPanel />);
    await screen.findByText('Vault');

    fireEvent.change(screen.getByPlaceholderText(/Purpose \(e\.g\. prod-corpus/), { target: { value: 'prod-corpus signing key' } });
    fireEvent.change(screen.getByPlaceholderText(/Requester DID/), { target: { value: 'did:imajin:prod-corpus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose mint' }));

    await waitFor(() => expect(screen.getByText('Proposal raised — approve it below to sign.')).toBeDefined());
    const proposalCall = spy.mock.calls.find(([url]) => String(url).includes('/vault-proposals'));
    const sentBody = JSON.parse((proposalCall?.[1] as { body: string }).body) as { kind: string; detail: Record<string, unknown> };
    expect(sentBody.kind).toBe('mint');
    expect(sentBody.detail).toEqual({ purpose: 'prod-corpus signing key', requesterDid: 'did:imajin:prod-corpus' });
  });

  it('shows the server error message when the proposal request fails', async () => {
    installFetch({ proposalResponse: { ok: false, status: 400, body: { error: 'detail.purpose is required' } } });
    render(<VaultKeysPanel />);
    await screen.findByText('Vault');

    fireEvent.change(screen.getByPlaceholderText(/Purpose \(e\.g\. prod-corpus/), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Requester DID/), { target: { value: 'did:imajin:x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose mint' }));

    expect(await screen.findByText('detail.purpose is required')).toBeDefined();
  });
});

describe('per-card proposal actions', () => {
  it('submits a vault:grant proposal from the Grant access form', async () => {
    const spy = installFetch({ cardsResponse: { keys: [keyCard()], handProvisioned: [] } });
    render(<VaultKeysPanel />);
    await screen.findByTestId('vault-key-card');

    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    fireEvent.change(screen.getByPlaceholderText(/Consumer DID/), { target: { value: 'did:imajin:prod-corpus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose grant' }));

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('/vault-proposals'))).toBe(true));
    const proposalCall = spy.mock.calls.find(([url]) => String(url).includes('/vault-proposals'));
    const sentBody = JSON.parse((proposalCall?.[1] as { body: string }).body) as { kind: string; detail: Record<string, unknown> };
    expect(sentBody.kind).toBe('grant');
    expect(sentBody.detail.did).toBe(keyCard().did);
    expect(sentBody.detail.grantedTo).toBe('did:imajin:prod-corpus');
  });

  it('submits a vault:rotate proposal when Rotate is clicked', async () => {
    const spy = installFetch({ cardsResponse: { keys: [keyCard()], handProvisioned: [] } });
    render(<VaultKeysPanel />);
    await screen.findByTestId('vault-key-card');

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('/vault-proposals'))).toBe(true));
    const proposalCall = spy.mock.calls.find(([url]) => String(url).includes('/vault-proposals'));
    const sentBody = JSON.parse((proposalCall?.[1] as { body: string }).body) as { kind: string; detail: Record<string, unknown> };
    expect(sentBody.kind).toBe('rotate');
    expect(sentBody.detail.did).toBe(keyCard().did);
  });

  it('submits a vault:revoke proposal with the selected tier, showing the dignity warning for destroy', async () => {
    const spy = installFetch({ cardsResponse: { keys: [keyCard()], handProvisioned: [] } });
    render(<VaultKeysPanel />);
    await screen.findByTestId('vault-key-card');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'destroy' } });
    // The select's own 'destroy' option text also contains 'irreversible',
    // so this checks for the warning paragraph's distinctive phrase instead.
    expect(screen.getByText(/cannot be undone/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Propose destroy' }));

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('/vault-proposals'))).toBe(true));
    const proposalCall = spy.mock.calls.find(([url]) => String(url).includes('/vault-proposals'));
    const sentBody = JSON.parse((proposalCall?.[1] as { body: string }).body) as { kind: string; detail: Record<string, unknown> };
    expect(sentBody.kind).toBe('revoke');
    expect(sentBody.detail.tier).toBe('destroy');
  });

  it('does not render any proposal action buttons for a revoked key', async () => {
    installFetch({ cardsResponse: { keys: [keyCard({ status: 'revoked' })], handProvisioned: [] } });
    render(<VaultKeysPanel />);
    await screen.findByTestId('vault-key-card');

    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});

describe('poll refresh', () => {
  it('registers a poll interval and silently refetches on each tick', async () => {
    const callbacks = installIntervalSpy();
    const spy = installFetch({});
    render(<VaultKeysPanel />);
    await screen.findByText('Vault');
    expect(spy).toHaveBeenCalledTimes(1);

    callbacks[0]();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
