// @vitest-environment jsdom
/**
 * Component tests for the /jin operator-approvals panel (#2059, per-source
 * renderer registry #2152): the operator-only visibility gate, the
 * empty/pending/approved render states, the Approve/Reject/Withdraw click
 * paths against `GET`/`POST /jin/api/operator-approvals`, and the
 * per-source renderer registry (default vs. skill-workshop).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { crypto as authCrypto } from '@imajin/auth';
import { OperatorApprovalsPanel } from '../operator-approvals-panel';
import { installIntervalSpy } from './panel-test-support';

interface ApprovalFixture {
  proposalId: string;
  source: string;
  kind: string;
  summary: string;
  keysTouched: string[];
  detail: Record<string, unknown> | null;
  status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'applied' | 'expired';
  decision: null;
  /** Post-exec outcome follow-up (#2221 exec.command; #2293 github approvedUntil/ownerAuthorization). */
  outcome?: Record<string, unknown> | null;
  appliedAt: string | null;
  createdAt: string;
}

function approval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return {
    proposalId: 'opap_1',
    source: 'system-agent',
    kind: 'system-agent:restart',
    summary: 'Restart the gateway to load the updated plugin.',
    keysTouched: ['gateway.plugins.openclaw.version'],
    detail: null,
    status: 'pending',
    decision: null,
    appliedAt: null,
    createdAt: new Date('2026-09-08T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function skillWorkshopApproval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return approval({
    proposalId: 'opap_sw_1',
    source: 'skill-workshop',
    kind: 'skill-workshop:update',
    summary: 'Update the weather-lookup skill.',
    keysTouched: [],
    detail: {
      skillName: 'weather-lookup',
      kind: 'update',
      scan: 'clean',
      description: 'Adds a 5-day forecast endpoint.',
      diffSummary: '+12 -3 lines in src/weather.ts',
    },
    ...overrides,
  });
}

function vaultApproval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return approval({
    proposalId: 'opap_vault_1',
    source: 'vault',
    kind: 'vault:mint',
    summary: 'Mint a new vault-native service key for "corpus-identity", delivered to did:imajin:corpus-bootstrap.',
    keysTouched: [],
    detail: { purpose: 'corpus-identity', requesterDid: 'did:imajin:corpus-bootstrap' },
    ...overrides,
  });
}

function accessApproval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return approval({
    proposalId: 'opap_access_1',
    source: 'access',
    kind: 'access:bearer-grant',
    summary: '"Muse Code" is asking to connect via mcp for: read my media',
    keysTouched: [],
    detail: {
      requestId: 'dgr_1',
      clientLabel: 'Muse Code',
      purpose: 'read my media',
      scopes: ['discovery:read'],
      surfaces: ['mcp'],
    },
    ...overrides,
  });
}

function githubApproval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return approval({
    proposalId: 'opap_gh_1',
    source: 'github',
    kind: 'github:append',
    summary: 'create_issue org/repo: "Bug: widget breaks"',
    keysTouched: [],
    detail: {
      ownerDid: 'did:imajin:owner',
      agentDid: null,
      scope: 'github:write',
      riskTier: 'append',
      tool: 'github_create_issue',
      target: 'org/repo',
      argsSummary: 'create_issue org/repo: "Bug: widget breaks"',
    },
    outcome: null,
    ...overrides,
  });
}

function gatewayExecApproval(overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return approval({
    proposalId: 'opap_exec_1',
    source: 'gateway-exec',
    kind: 'gateway-exec:command',
    summary: 'Restart the gateway on gateway-01.',
    keysTouched: [],
    detail: {
      command: 'systemctl restart openclaw-gateway',
      host: 'gateway-01',
      cwd: '/opt/openclaw',
      agentId: 'agent_123',
      sessionKey: 'session_abc',
      requestedBy: 'did:imajin:jin-agent',
      approvalId: 'oc_approval_1',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
    outcome: null,
    ...overrides,
  });
}

/** Installs a fetch stub: GET list responses come from `listResponses` in order; any POST decision call resolves with `decisionResponse`. */
function installFetch(
  listResponses: Array<{ isOperator: boolean; approvals: ApprovalFixture[] }>,
  decisionResponse: { ok: boolean; status?: number; body?: unknown } = { ok: true, body: { approval: approval({ status: 'approved' }) } },
) {
  let callIndex = 0;
  const spy = vi.fn((url: string) => {
    if (url.includes('/decision')) {
      return Promise.resolve({
        ok: decisionResponse.ok,
        status: decisionResponse.status ?? (decisionResponse.ok ? 200 : 400),
        json: async () => decisionResponse.body ?? {},
      } as unknown as Response);
    }
    const listResponse = listResponses[Math.min(callIndex, listResponses.length - 1)];
    callIndex += 1;
    return Promise.resolve({ ok: true, status: 200, json: async () => listResponse } as unknown as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('non-operator visibility (#2059 acceptance (c))', () => {
  it('renders nothing at all — no header, no empty state — for a non-operator', async () => {
    const spy = installFetch([{ isOperator: false, approvals: [] }]);
    const { container } = render(<OperatorApprovalsPanel />);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Operator approvals')).toBeNull();
  });

  it('renders nothing while the initial operator check is still loading', () => {
    installFetch([{ isOperator: true, approvals: [] }]);
    const { container } = render(<OperatorApprovalsPanel />);

    // Before the fetch resolves, isOperator is still its initial `false`.
    expect(container.firstChild).toBeNull();
  });
});

describe('operator — empty state', () => {
  it('shows the panel header and empty-state copy when there are no proposals', async () => {
    installFetch([{ isOperator: true, approvals: [] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('Operator approvals')).toBeDefined();
    expect(screen.getByText('No operator approvals yet.')).toBeDefined();
  });
});

describe('operator — pending proposal (legacy/system-agent, default renderer)', () => {
  it('renders the summary, namespaced kind badge, keys touched, and Approve/Deny controls (#2152: normalized to system-agent:*)', async () => {
    installFetch([{ isOperator: true, approvals: [approval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('Restart the gateway to load the updated plugin.')).toBeDefined();
    expect(screen.getByText('system-agent:restart')).toBeDefined();
    expect(screen.getByText('gateway.plugins.openclaw.version')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('shows the server error message and does not refresh when the decision request fails', async () => {
    installFetch(
      [{ isOperator: true, approvals: [approval()] }],
      { ok: false, status: 403, body: { error: 'Only the node operator may decide this proposal' } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Only the node operator may decide this proposal')).toBeDefined();
  });

  it('falls back to a generic error message when the failure response has no error field', async () => {
    installFetch([{ isOperator: true, approvals: [approval()] }], { ok: false, status: 500, body: {} });
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Decision failed (500)')).toBeDefined();
  });
});

describe('operator — approved (pending-apply) proposal', () => {
  it('shows the Withdraw control instead of Approve/Deny', async () => {
    installFetch([{ isOperator: true, approvals: [approval({ status: 'approved' })] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });
});

// Approve/Reject/Withdraw share the same request/refresh shape (post the
// decision, flash "Proposal <decision>.", then show the refreshed status) —
// parameterized instead of three near-identical test bodies. The default
// renderer's Deny BUTTON LABEL is unchanged (#2152 only widens the wire
// vocabulary from 'deny' to 'reject'; decisionLabels.reject still reads
// 'Deny' for system-agent).
describe.each([
  { buttonName: 'Approve', decision: 'approve', from: approval(), to: approval({ status: 'approved' }), resultingStatusText: 'approved — pending apply' },
  { buttonName: 'Deny', decision: 'reject', from: approval(), to: approval({ status: 'denied' }), resultingStatusText: 'denied' },
  { buttonName: 'Withdraw', decision: 'withdrawn', from: approval({ status: 'approved' }), to: approval({ status: 'withdrawn' }), resultingStatusText: 'withdrawn' },
])('operator — $buttonName action', ({ buttonName, decision, from, to, resultingStatusText }) => {
  it(`posts decision=${decision} and refreshes to the new state`, async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [from] }, { isOperator: true, approvals: [to] }],
      { ok: true, body: { approval: to } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: buttonName });

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(screen.getByText(`Proposal ${decision}.`)).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[0]).toBe('/jin/api/operator-approvals/opap_1/decision');
    expect(decisionCall?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ decision }),
    });
    await waitFor(() => expect(screen.getByText(resultingStatusText)).toBeDefined());
  });
});

describe('terminal statuses', () => {
  it('shows no action controls for an applied proposal', async () => {
    installFetch([{ isOperator: true, approvals: [approval({ status: 'applied' })] }]);
    render(<OperatorApprovalsPanel />);

    await screen.findByText('applied');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('shows no action controls for a denied proposal', async () => {
    installFetch([{ isOperator: true, approvals: [approval({ status: 'denied' })] }]);
    render(<OperatorApprovalsPanel />);

    await screen.findByText('denied');
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });
});

describe('poll refresh', () => {
  it('registers a poll interval and silently refetches the list on each tick', async () => {
    const callbacks = installIntervalSpy();
    const spy = installFetch([
      { isOperator: true, approvals: [approval()] },
      { isOperator: true, approvals: [approval({ status: 'approved' })] },
    ]);
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });
    expect(spy).toHaveBeenCalledTimes(1);

    callbacks[0]();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('approved — pending apply')).toBeDefined();
  });

  it('clears the poll interval on unmount', async () => {
    installIntervalSpy();
    installFetch([{ isOperator: true, approvals: [] }]);
    const { unmount } = render(<OperatorApprovalsPanel />);
    await screen.findByText('Operator approvals');

    unmount();

    expect(globalThis.clearInterval).toHaveBeenCalled();
  });
});

describe('network failure', () => {
  it('does not throw and stays hidden when the initial fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { container } = render(<OperatorApprovalsPanel />);

    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});

describe('manual refresh', () => {
  it('refetches the list when the refresh button is clicked', async () => {
    const spy = installFetch([
      { isOperator: true, approvals: [] },
      { isOperator: true, approvals: [approval()] },
    ]);
    render(<OperatorApprovalsPanel />);
    await screen.findByText('No operator approvals yet.');

    fireEvent.click(screen.getByRole('button', { name: '↺ refresh' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Restart the gateway to load the updated plugin.')).toBeDefined();
  });
});

describe('operator countersignature (#2082)', () => {
  it('signs the decision client-side and includes operatorSignature + decidedAt when a local keypair is present', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey, publicKey }));

    const spy = installFetch(
      [{ isOperator: true, approvals: [approval()] }, { isOperator: true, approvals: [approval({ status: 'approved' })] }],
      { ok: true, body: { approval: approval({ status: 'approved' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    const sentBody = JSON.parse((decisionCall?.[1] as { body: string }).body) as {
      decision: string;
      decidedAt: string;
      operatorSignature: { keyId: string; alg: string; sig: string };
    };
    expect(sentBody.decision).toBe('approve');
    expect(typeof sentBody.decidedAt).toBe('string');
    expect(sentBody.operatorSignature).toEqual({ keyId: publicKey, alg: 'ed25519', sig: expect.stringMatching(/^[0-9a-f]{128}$/) });

    localStorage.removeItem('imajin_keypair');
  });

  it('omits operatorSignature when no local keypair is present (unchanged pre-#2082 behavior)', async () => {
    expect(localStorage.getItem('imajin_keypair')).toBeNull();

    const spy = installFetch([{ isOperator: true, approvals: [approval()] }, { isOperator: true, approvals: [approval({ status: 'approved' })] }]);
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'approve' }) });
  });
});

// Per-source renderer registry (#2152): a source with no registry entry
// (including 'system-agent') falls back to the default renderer above;
// 'skill-workshop' gets its own detail rendering and Apply/Reject labels.
describe('per-source renderer registry — skill-workshop', () => {
  it('renders skill name, create/update, scan status, description, and diff summary instead of the default card body', async () => {
    installFetch([{ isOperator: true, approvals: [skillWorkshopApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('weather-lookup')).toBeDefined();
    expect(screen.getByText('— update')).toBeDefined();
    expect(screen.getByText('clean')).toBeDefined();
    expect(screen.getByText('Adds a 5-day forecast endpoint.')).toBeDefined();
    expect(screen.getByText('+12 -3 lines in src/weather.ts')).toBeDefined();
    // The default renderer's own fields must not leak through for this source.
    expect(screen.queryByText('Keys touched')).toBeNull();
  });

  it('shows Apply/Reject button labels instead of the default Approve/Deny', async () => {
    installFetch([{ isOperator: true, approvals: [skillWorkshopApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'Apply' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('posts decision=approve when Apply is clicked (labels are cosmetic only — the wire vocabulary stays approve|reject)', async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [skillWorkshopApproval()] }, { isOperator: true, approvals: [skillWorkshopApproval({ status: 'approved' })] }],
      { ok: true, body: { approval: skillWorkshopApproval({ status: 'approved' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Apply' });

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'approve' }) });
  });

  it('falls back to the default renderer for an unregistered source', async () => {
    installFetch([{ isOperator: true, approvals: [approval({ source: 'some-future-source', kind: 'some-future-source:thing' })] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
    expect(screen.getByText('some-future-source:thing')).toBeDefined();
  });
});

// `gateway-exec` renderer (#2221): verbatim command block, host/cwd/agent
// badges, expiry countdown/expired state, and allow-once/deny-only labels.
describe('per-source renderer registry — gateway-exec', () => {
  it('renders the verbatim command block, host badge, cwd, agent + session, and an expiry countdown', async () => {
    installFetch([{ isOperator: true, approvals: [gatewayExecApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('systemctl restart openclaw-gateway')).toBeDefined();
    expect(screen.getByText('gateway-01')).toBeDefined();
    expect(screen.getByText('/opt/openclaw')).toBeDefined();
    expect(screen.getByText('agent_123')).toBeDefined();
    expect(screen.getByText('session_abc')).toBeDefined();
    expect(screen.getByText(/expires in/)).toBeDefined();
  });

  it('offers only Allow once / Deny — never a third (allow-always) button', async () => {
    installFetch([{ isOperator: true, approvals: [gatewayExecApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'Allow once' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: /allow.always/i })).toBeNull();
  });

  it('posts decision=approve when Allow once is clicked (labels are cosmetic only)', async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [gatewayExecApproval()] }, { isOperator: true, approvals: [gatewayExecApproval({ status: 'approved' })] }],
      { ok: true, body: { approval: gatewayExecApproval({ status: 'approved' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Allow once' });

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'approve' }) });
  });

  it('shows an expired indicator and no decision controls once detail.expiresAt has passed (#2221)', async () => {
    const expired = gatewayExecApproval({
      detail: { ...gatewayExecApproval().detail, expiresAt: '2000-01-01T00:00:00.000Z' },
    });
    installFetch([{ isOperator: true, approvals: [expired] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('expired — can no longer be decided')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('renders the post-exec outcome (exit code, duration, output hash) once attached', async () => {
    const withOutcome = gatewayExecApproval({
      status: 'approved',
      outcome: { exitCode: 0, durationMs: 842, outputHash: 'a'.repeat(64) },
    });
    installFetch([{ isOperator: true, approvals: [withOutcome] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('exit 0')).toBeDefined();
    expect(screen.getByText('842ms')).toBeDefined();
    expect(screen.getByText('a'.repeat(64))).toBeDefined();
  });

  it('shows no outcome section before one is attached', async () => {
    installFetch([{ isOperator: true, approvals: [gatewayExecApproval()] }]);
    render(<OperatorApprovalsPanel />);

    await screen.findByText('systemctl restart openclaw-gateway');
    expect(screen.queryByText(/^exit /)).toBeNull();
  });
});

// `vault` renderer (#2247): mint/grant/rotate/revoke proposals raised from
// the /jin Vault section or by an agent in chat, riding this SAME approvals
// rail. Approving them is the signing event for the actual vault mutation.
describe('per-source renderer registry — vault', () => {
  it('renders the mint detail (purpose + delivered-to) and Sign/Deny controls', async () => {
    installFetch([{ isOperator: true, approvals: [vaultApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('corpus-identity')).toBeDefined();
    expect(screen.getByText('did:imajin:corpus-bootstrap')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
  });

  it('renders the grant detail (key/grant-to/one-time)', async () => {
    const grantApproval = vaultApproval({
      kind: 'vault:grant',
      detail: { did: 'did:imajin:x', grantedTo: 'did:imajin:prod-corpus', oneTime: true },
    });
    installFetch([{ isOperator: true, approvals: [grantApproval] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('did:imajin:x')).toBeDefined();
    expect(screen.getByText('did:imajin:prod-corpus')).toBeDefined();
  });

  it('renders the rotate detail', async () => {
    const rotateApproval = vaultApproval({ kind: 'vault:rotate', detail: { did: 'did:imajin:x' } });
    installFetch([{ isOperator: true, approvals: [rotateApproval] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText(/mint a replacement, grant its current consumer/)).toBeDefined();
  });

  it('shows a tier-specific button label for revoke — Withdraw', async () => {
    const revokeApproval = vaultApproval({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier: 'withdraw' } });
    installFetch([{ isOperator: true, approvals: [revokeApproval] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
  });

  it('shows the dignity-warning copy only for the destroy tier', async () => {
    const destroyApproval = vaultApproval({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier: 'destroy' } });
    installFetch([{ isOperator: true, approvals: [destroyApproval] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'Destroy' })).toBeDefined();
    expect(screen.getByText(/irreversible/)).toBeDefined();
  });

  it('does not show the dignity warning for withdraw/tombstone tiers', async () => {
    const tombstoneApproval = vaultApproval({ kind: 'vault:revoke', detail: { did: 'did:imajin:x', tier: 'tombstone' } });
    installFetch([{ isOperator: true, approvals: [tombstoneApproval] }]);
    render(<OperatorApprovalsPanel />);

    await screen.findByRole('button', { name: 'Tombstone' });
    expect(screen.queryByText(/irreversible/)).toBeNull();
  });

  it('posts decision=approve when Sign is clicked on a mint proposal', async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [vaultApproval()] }, { isOperator: true, approvals: [vaultApproval({ status: 'approved' })] }],
      { ok: true, body: { approval: vaultApproval({ status: 'approved' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Sign' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'approve' }) });
  });
});

// `access` renderer (#2252): delegate-grant bearer knocks. Approving mints
// the bearer server-side and returns its plaintext exactly once via
// `data.bearer` in the decision response — surfaced as a persistent reveal
// box, not the 4s auto-dismissing flash.
describe('per-source renderer registry — access', () => {
  it('renders the client/purpose/scopes/surfaces detail and Approve & mint bearer / Deny controls', async () => {
    installFetch([{ isOperator: true, approvals: [accessApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('Muse Code')).toBeDefined();
    expect(screen.getByText('read my media')).toBeDefined();
    expect(screen.getByText('discovery:read')).toBeDefined();
    expect(screen.getByText('mcp')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve & mint bearer' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined();
  });

  it('falls back to em-dash placeholders when scopes/surfaces are absent from detail', async () => {
    installFetch([{ isOperator: true, approvals: [accessApproval({ detail: { requestId: 'dgr_1', clientLabel: 'Muse Code', purpose: 'p' } })] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('Muse Code')).toBeDefined();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('reveals the minted bearer plaintext exactly once when the decision response carries data.bearer', async () => {
    installFetch(
      [{ isOperator: true, approvals: [accessApproval()] }, { isOperator: true, approvals: [accessApproval({ status: 'approved' })] }],
      { ok: true, body: { approval: accessApproval({ status: 'approved' }), data: { bearer: 'plaintext-secret-xyz', bearerId: 'dgb_1', expiresAt: '2026-04-01T00:00:00.000Z', hardCapAt: '2026-04-15T00:00:00.000Z' } } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve & mint bearer' });

    fireEvent.click(screen.getByRole('button', { name: 'Approve & mint bearer' }));

    const revealBox = await screen.findByTestId('revealed-bearer');
    expect(within(revealBox).getByText('plaintext-secret-xyz')).toBeDefined();
    expect(within(revealBox).getByText(/Muse Code/)).toBeDefined();
  });

  it('never reveals a bearer for a reject decision (no data in the response)', async () => {
    installFetch(
      [{ isOperator: true, approvals: [accessApproval()] }, { isOperator: true, approvals: [accessApproval({ status: 'denied' })] }],
      { ok: true, body: { approval: accessApproval({ status: 'denied' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Deny' });

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(screen.getByText('Proposal reject.')).toBeDefined());
    expect(screen.queryByTestId('revealed-bearer')).toBeNull();
  });

  it('dismisses the reveal box, copies to the clipboard, and never shows it again after dismissal', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    installFetch(
      [{ isOperator: true, approvals: [accessApproval()] }, { isOperator: true, approvals: [accessApproval({ status: 'approved' })] }],
      { ok: true, body: { approval: accessApproval({ status: 'approved' }), data: { bearer: 'plaintext-secret-xyz', bearerId: 'dgb_1', expiresAt: '2026-04-01T00:00:00.000Z' } } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Approve & mint bearer' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve & mint bearer' }));
    await screen.findByTestId('revealed-bearer');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('plaintext-secret-xyz');

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('revealed-bearer')).toBeNull();
  });
});

// `github` renderer (#2293): folds the retired pre-#2059 confirm rail into
// this rail. Unlike every other source, pending offers FOUR buttons (No /
// Yes / 5m / 24h) instead of the generic two — the TTL choice a windowed
// approval needs — and an approved card shows a live countdown once
// `outcome.approvedUntil` is set.
describe('per-source renderer registry — github', () => {
  it('renders the args summary, tool, target, and risk tier', async () => {
    installFetch([{ isOperator: true, approvals: [githubApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('create_issue org/repo: "Bug: widget breaks"')).toBeDefined();
    expect(screen.getByText('github_create_issue')).toBeDefined();
    expect(screen.getByText('org/repo')).toBeDefined();
    expect(screen.getByText('append')).toBeDefined();
  });

  it('offers No / Yes / 5m / 24h instead of the default two-button row', async () => {
    installFetch([{ isOperator: true, approvals: [githubApproval()] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByRole('button', { name: 'No' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeDefined();
    expect(screen.getByRole('button', { name: '5m' })).toBeDefined();
    expect(screen.getByRole('button', { name: '24h' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('posts decision=approve with mode=single when Yes is clicked', async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [githubApproval()] }, { isOperator: true, approvals: [githubApproval({ status: 'approved' })] }],
      { ok: true, body: { approval: githubApproval({ status: 'approved' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Yes' });

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'approve', mode: 'single' }) });
  });

  it('posts decision=approve with mode=5m when the 5m button is clicked', async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [githubApproval()] }, { isOperator: true, approvals: [githubApproval({ status: 'approved' })] }],
      { ok: true, body: { approval: githubApproval({ status: 'approved' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: '5m' });

    fireEvent.click(screen.getByRole('button', { name: '5m' }));

    await waitFor(() => expect(screen.getByText('Proposal approve.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'approve', mode: '5m' }) });
  });

  it('posts decision=reject (no mode) when No is clicked', async () => {
    const spy = installFetch(
      [{ isOperator: true, approvals: [githubApproval()] }, { isOperator: true, approvals: [githubApproval({ status: 'denied' })] }],
      { ok: true, body: { approval: githubApproval({ status: 'denied' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'No' });

    fireEvent.click(screen.getByRole('button', { name: 'No' }));

    await waitFor(() => expect(screen.getByText('Proposal reject.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'reject' }) });
  });

  it('shows a live TTL countdown for a windowed approval and offers Withdraw', async () => {
    const windowed = githubApproval({
      status: 'approved',
      outcome: { approvedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(), ownerAuthorization: { signature: 'sig', senderPubkey: 'pub', payload: {} } },
    });
    installFetch([{ isOperator: true, approvals: [windowed] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText(/expires in/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDefined();
  });

  it('labels a single-call approval distinctly from a windowed one', async () => {
    const single = githubApproval({
      status: 'approved',
      outcome: { approvedUntil: null, ownerAuthorization: { signature: 'sig', senderPubkey: 'pub', payload: {} } },
    });
    installFetch([{ isOperator: true, approvals: [single] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText(/single-call approval/)).toBeDefined();
    expect(screen.queryByText(/expires in/)).toBeNull();
  });

  it('shows the expired badge and no decision controls for an expired proposal', async () => {
    installFetch([{ isOperator: true, approvals: [githubApproval({ status: 'expired' })] }]);
    render(<OperatorApprovalsPanel />);

    expect(await screen.findByText('expired')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('posts decision=withdrawn when Withdraw is clicked on an approved github card', async () => {
    const windowed = githubApproval({
      status: 'approved',
      outcome: { approvedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(), ownerAuthorization: {} },
    });
    const spy = installFetch(
      [{ isOperator: true, approvals: [windowed] }, { isOperator: true, approvals: [githubApproval({ status: 'expired' })] }],
      { ok: true, body: { approval: githubApproval({ status: 'expired' }) } },
    );
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Withdraw' });

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));

    await waitFor(() => expect(screen.getByText('Proposal withdrawn.')).toBeDefined());
    const decisionCall = spy.mock.calls.find(([url]) => String(url).includes('/decision'));
    expect(decisionCall?.[1]).toMatchObject({ body: JSON.stringify({ decision: 'withdrawn' }) });
  });
});
