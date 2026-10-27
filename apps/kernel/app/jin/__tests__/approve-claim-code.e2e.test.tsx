// @vitest-environment jsdom
/**
 * #2707 — approve → claim-code banner, and reissue, end to end.
 *
 * The panels' `fetch` is wired straight into the REAL
 * `POST /jin/api/operator-approvals/:proposalId/decision` and
 * `POST /api/apps/provision` handlers, and the decision route runs the REAL
 * `executeAppsProvisionApproval` bridge. Only the I/O edges are stubbed (auth,
 * the DB-backed approvals store, and the provisioning pipeline itself), so a
 * shape mismatch between what the routes return and what the panels read cannot
 * hide behind a hand-written response fixture.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { crypto as authCrypto } from '@imajin/auth';
import { OPERATOR_DID, operatorIdentity, pendingApprovalCard } from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';
import { computeApprovalContentHash, type OperatorCountersignature } from '@/src/lib/notify/operator-approvals';
import { countersignedMessage } from '@/src/lib/notify/operator-countersign-fields';

const { mockRequireAuth, mockGetOperatorDid, mockDecide, mockRecordRequested, mockRunAppProvision, mockGetStatus, mockGetSignInAudience, mockListSucceeded, logSpies } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockDecide: vi.fn(),
  mockRecordRequested: vi.fn(),
  mockRunAppProvision: vi.fn(),
  mockGetStatus: vi.fn(),
  mockGetSignInAudience: vi.fn(),
  mockListSucceeded: vi.fn(),
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const searchParamsMock = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => searchParamsMock.current }));

vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: mockRequireAuth };
});
vi.mock('@/src/lib/vault/approvals-execution', () => ({ executeVaultApproval: vi.fn() }));
vi.mock('@/src/lib/access/approvals-execution', () => ({ executeAccessApproval: vi.fn() }));
vi.mock('@/src/lib/github/approvals-execution', () => ({ executeGithubApproval: vi.fn(), GITHUB_SOURCE: 'github' }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => logSpies }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));
vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});
vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  decideOperatorApproval: mockDecide,
  recordApprovalRequested: mockRecordRequested,
}));
vi.mock('@/src/lib/apps/provision', () => ({
  runAppProvision: mockRunAppProvision,
  getAppProvisionStatus: mockGetStatus,
  getProvisionSignInAudience: mockGetSignInAudience,
}));
vi.mock('@/src/lib/apps/provision-proposals', () => ({ findPendingAppsProvisionProposal: vi.fn(async () => undefined) }));
vi.mock('@/src/lib/apps/provision-list', () => ({ listSucceededAppProvisions: mockListSucceeded }));
vi.mock('@/src/lib/apps/manifest-preview', () => ({ previewManifestDeclarations: vi.fn(async () => ({ ok: null })) }));

import { POST as decisionPost } from '../api/operator-approvals/[proposalId]/decision/route';
import { POST as provisionPost, GET as provisionGet } from '../../api/apps/provision/route';
import { OperatorApprovalsPanel } from '../operator-approvals-panel';
import { ProvisionAppPanel } from '../provision-app-panel';
import { requestApprovalsRefresh } from '../approval-anchor';

const CLAIM_CODE = 'claim_e2e_plaintext_code';
const REISSUED_CODE = 'claim_e2e_reissued_code';
const SECRET_CODES = [CLAIM_CODE, REISSUED_CODE];
const GBS_DID = 'did:imajin:4HAssJChzMLewFpeNrH3pJGPp71nxpefLEihoid8uB2Q';

type Card = ReturnType<typeof pendingApprovalCard>;

/** In-memory stand-in for the `operator.approvals` table. */
let cards: Card[] = [];

function appsCard(overrides: Record<string, unknown> = {}): Card {
  return pendingApprovalCard({
    proposalId: 'appprov_e2e',
    source: 'apps',
    kind: 'apps:provision',
    summary: "Provision app 'dykil' (Dykil)",
    detail: { slug: 'dykil', displayName: 'Dykil', template: null, attestationTypes: [] },
    ...overrides,
  });
}

const succeededOutcome = (claimCode: string) => ({
  status: 'succeeded',
  repoUrl: 'https://github.com/ima-jin/dykil',
  appDid: 'did:imajin:dykil-app',
  secretsSet: [],
  attestationTypeResults: [],
  claimCode,
});

/** Last decision response body, kept so the secret-handling test can inspect exactly what crossed the wire. */
let lastDecisionBody = '';
const routedRequests = new Set<Promise<Response>>();
let decisionSettled: (() => void) | undefined;

/** Await real signing + route execution before starting a DOM query's short retry window. */
async function approveDecision(button: HTMLElement) {
  try {
    await act(async () => {
      const completed = new Promise<void>((resolve) => { decisionSettled = resolve; });
      fireEvent.click(button);
      await completed;
    });
    // The response reveals the code before handleDecide awaits its list refresh.
    await waitFor(() => {
      expect(screen.queryAllByRole('button', { name: '…' })).toHaveLength(0);
    });
  } finally {
    decisionSettled = undefined;
  }
}

/** Routes fetches into the real handlers; the approvals list is served from `cards`. */
function installRoutedFetch(options: { dropDecision?: boolean; dropFirstDecision?: boolean; decisionStatus?: number } = {}) {
  let dropFirstDecision = options.dropFirstDecision === true;
  const route = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/auth/api/groups') {
      return Response.json([{ groupDid: GBS_DID, role: 'owner', scope: 'business', handle: 'gbs', name: 'GBS' }]);
    }
    if (url.includes('/decision')) {
      if (options.dropDecision || dropFirstDecision) {
        dropFirstDecision = false;
        throw new TypeError('network error');
      }
      // A proxy answering for a request that is still (or was) running behind it.
      if (options.decisionStatus) return new Response('Gateway Time-out', { status: options.decisionStatus });
      const proposalId = decodeURIComponent(url.split('/operator-approvals/')[1].split('/')[0]);
      const res = await decisionPost(
        new Request(`https://test.imajin.ai${url}`, init) as Parameters<typeof decisionPost>[0],
        { params: Promise.resolve({ proposalId }) },
      );
      lastDecisionBody = await res.clone().text();
      return res as Response;
    }
    if (url === '/api/apps/provision' && init?.method === 'POST') {
      return (await provisionPost(new Request(`https://test.imajin.ai${url}`, init) as Parameters<typeof provisionPost>[0])) as Response;
    }
    if (url === '/api/apps/provision?status=succeeded') {
      return (await provisionGet(new Request(`https://test.imajin.ai${url}`, init) as Parameters<typeof provisionGet>[0])) as Response;
    }
    if (url.startsWith('/api/apps/provision?slug=')) {
      return new Response(JSON.stringify({ error: 'none' }), { status: 404 });
    }
    return new Response(JSON.stringify({ isOperator: true, approvals: cards, actAs: null }), { status: 200 });
  };
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const request = route(url, init);
    routedRequests.add(request);
    try {
      return await request;
    } finally {
      routedRequests.delete(request);
      if (url.includes('/decision')) decisionSettled?.();
    }
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  vi.useRealTimers();
  for (const mock of [
    mockRequireAuth, mockGetOperatorDid, mockDecide, mockRecordRequested,
    mockRunAppProvision, mockGetStatus, mockGetSignInAudience, mockListSucceeded, ...Object.values(logSpies),
  ]) mock.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  searchParamsMock.current = new URLSearchParams();
  cards = [];
  lastDecisionBody = '';
  decisionSettled = undefined;
  const { privateKey, publicKey } = authCrypto.generateKeypair();
  localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey, publicKey }));
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockRequireAuth.mockResolvedValue({ identity: operatorIdentity() });
  mockGetStatus.mockResolvedValue(undefined);
  mockGetSignInAudience.mockResolvedValue('members');
  mockListSucceeded.mockResolvedValue([]);
  mockRecordRequested.mockImplementation(async (params: Record<string, unknown>) => {
    cards.push(
      pendingApprovalCard({
        proposalId: params.proposalId,
        source: params.source,
        kind: params.kind,
        summary: params.summary,
        detail: params.detail,
        contentHash: params.contentHash,
      }),
    );
  });
  // The real service verifies + persists the countersignature; here we just carry it onto the card.
  mockDecide.mockImplementation(async (params: { proposalId: string; decision: string; decidedAt?: string; operatorSignature?: unknown }) => {
    const index = cards.findIndex((card) => card.proposalId === params.proposalId);
    cards[index] = {
      ...cards[index],
      status: 'approved',
      decision: {
        proposalId: params.proposalId,
        decision: params.decision,
        decidedBy: OPERATOR_DID,
        decidedAt: params.decidedAt ?? new Date().toISOString(),
        ...(params.operatorSignature ? { operatorSignature: params.operatorSignature } : {}),
      },
    } as Card;
    return { ok: true, card: cards[index] };
  });
  mockRunAppProvision.mockResolvedValue(succeededOutcome(CLAIM_CODE));
});

it('countersigns the private dev GBS panel choices unchanged into the provision execution', async () => {
  installRoutedFetch();
  render(<><ProvisionAppPanel /><OperatorApprovalsPanel /></>);
  await screen.findByTestId('provision-app-panel');
  await screen.findByRole('option', { name: /@gbs/ });
  for (const [label, value] of [
    ['Slug', 'gbs'], ['Display name', 'GBS'], ['Source repository', 'gbscontracting/website'],
    ['Visibility', 'private'], ['Domain', 'dev-gbs.imajin.ai'], ['Site owner', GBS_DID],
  ]) fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Propose provision' })); });
  await act(async () => { requestApprovalsRefresh(); });
  const button = await screen.findByRole('button', { name: 'Approve & provision' });
  expect(cards[0].detail).toMatchObject({
    slug: 'gbs', sourceRepo: 'gbscontracting/website', visibility: 'private',
    domain: 'dev-gbs.imajin.ai', siteOwnerDid: GBS_DID,
  });
  expect(mockRunAppProvision).not.toHaveBeenCalled();
  await approveDecision(button);
  expect(mockRunAppProvision).toHaveBeenCalledWith(expect.objectContaining({
    slug: 'gbs', sourceRepo: 'gbscontracting/website', visibility: 'private',
    domain: 'dev-gbs.imajin.ai', siteOwnerDid: GBS_DID,
    authorizedBy: expect.objectContaining({ operatorDid: OPERATOR_DID }),
  }));
  expect(cards[0].decision?.operatorSignature).toBeDefined();
});

afterEach(async () => {
  try {
    // A reveal can render before its refresh/list requests finish. Keep the route
    // mocks and in-memory table alive until those requests and React work settle.
    await act(async () => {
      while (routedRequests.size) await Promise.allSettled([...routedRequests]);
    });
  } finally {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    cards = [];
    lastDecisionBody = '';
    searchParamsMock.current = new URLSearchParams();
    decisionSettled = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

function seedPendingProvision() {
  cards = [appsCard()];
}

describe('approve → claim-code banner (#2707)', () => {
  it('countersigns the visible external source and audience, rejecting signature tampering before revealing the claim code (#2932, #2957)', async () => {
    const sourceRepo = 'GBScontracting/Website';
    mockRunAppProvision.mockResolvedValue({
      ...succeededOutcome(CLAIM_CODE), repoUrl: `https://github.com/${sourceRepo}`,
    });
    installRoutedFetch();
    render(<ProvisionAppPanel />);
    await screen.findByTestId('provision-app-panel');
    fireEvent.change(screen.getByLabelText(/Slug/), { target: { value: 'gbs-contracting' } });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'GBS Contracting' } });
    fireEvent.change(screen.getByLabelText(/Source repository/), { target: { value: sourceRepo } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sign-in audience' }), { target: { value: 'anyone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose provision' }));
    await screen.findByTestId('provision-proposal-id');
    render(<OperatorApprovalsPanel />);

    const approve = await screen.findByRole('button', { name: 'Approve & provision' });
    expect(screen.getByText(sourceRepo)).toBeDefined();
    expect(screen.getByText(/No repository is created/)).toBeDefined();
    expect(screen.getByText('anyone')).toBeDefined();
    expect(mockRunAppProvision).not.toHaveBeenCalled();
    const proposed = mockRecordRequested.mock.calls[0][0];
    expect(proposed.detail.sourceRepo).toBe(sourceRepo);
    expect(proposed.detail.signInAudience).toBe('anyone');
    expect(proposed.summary).toContain('Sign-in audience: anyone');
    const hashFields = {
      proposalId: proposed.proposalId, source: proposed.source, kind: proposed.kind,
      summary: proposed.summary, keysTouched: proposed.keysTouched, detail: proposed.detail,
    };
    expect(proposed.contentHash).toBe(computeApprovalContentHash(hashFields));
    const changedSourceHash = computeApprovalContentHash({
      ...hashFields, detail: { ...proposed.detail, sourceRepo: 'other/website' },
    });
    expect(changedSourceHash).not.toBe(proposed.contentHash);
    const changedAudienceHash = computeApprovalContentHash({
      ...hashFields, detail: { ...proposed.detail, signInAudience: 'members' },
    });
    expect(changedAudienceHash).not.toBe(proposed.contentHash);

    await approveDecision(approve);
    const decision = mockDecide.mock.calls[0][0] as {
      decision: 'approve'; decidedAt: string; operatorSignature: OperatorCountersignature;
    };
    const signature = decision.operatorSignature;
    const signedFields = {
      contentHash: proposed.contentHash, decision: decision.decision, decidedAt: decision.decidedAt,
    };
    expect(signature.alg).toBe('ed25519');
    expect(authCrypto.verifySync(signature.sig, countersignedMessage(signedFields), signature.keyId)).toBe(true);
    expect(authCrypto.verifySync(signature.sig, countersignedMessage({
      ...signedFields, contentHash: changedSourceHash,
    }), signature.keyId)).toBe(false);
    expect(authCrypto.verifySync(signature.sig, countersignedMessage({
      ...signedFields, contentHash: changedAudienceHash,
    }), signature.keyId)).toBe(false);
    expect(mockRunAppProvision).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'gbs-contracting', sourceRepo, signInAudience: 'anyone',
      authorizedBy: expect.objectContaining({
        approvalId: proposed.proposalId, operatorDid: OPERATOR_DID, contentHash: proposed.contentHash,
      }),
    }));
    const box = await screen.findByTestId('revealed-claim-code');
    expect(within(box).getByText(CLAIM_CODE)).toBeDefined();
    expect(within(box).getByText(`${globalThis.location.origin}/gbs-contracting/claim`)).toBeDefined();
  });
  it('shows the amber claim-code box, with Copy and the /<slug>/claim link, after approving an apps:provision card', async () => {
    seedPendingProvision();
    installRoutedFetch();
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));

    const box = await screen.findByTestId('revealed-claim-code');
    expect(within(box).getByText(CLAIM_CODE)).toBeDefined();
    expect(within(box).getByText(`${globalThis.location.origin}/dykil/claim`)).toBeDefined();
    expect(within(box).getByRole('button', { name: 'Copy' })).toBeDefined();
    expect(within(box).getByRole('button', { name: 'Copy link' })).toBeDefined();
    expect(screen.queryByTestId('claim-code-missing')).toBeNull();
  });

  it('keeps the box through the post-approve refresh and the 5s poll (the card flips to approved underneath it)', async () => {
    // Leave crypto, Response streams, and Testing Library's retry timers real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    seedPendingProvision();
    const spy = installRoutedFetch();
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));
    await screen.findByTestId('revealed-claim-code');

    await screen.findByText('approved — pending apply');
    const beforePoll = spy.mock.calls.filter(([url]) => url === '/jin/api/operator-approvals?view=acting').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(spy.mock.calls.filter(([url]) => url === '/jin/api/operator-approvals?view=acting')).toHaveLength(beforePoll + 1);
    expect(screen.getByTestId('revealed-claim-code')).toBeDefined();
  });

  it('tells the operator — loudly, not a green "Proposal approve." — when the approve did not execute (no countersignature)', async () => {
    localStorage.removeItem('imajin_keypair');
    seedPendingProvision();
    installRoutedFetch();
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));

    const notice = await screen.findByTestId('claim-code-missing');
    expect(notice.textContent).toMatch(/requires a countersigned operator decision/);
    expect(screen.queryByTestId('revealed-claim-code')).toBeNull();
    expect(screen.queryByText('Proposal approve.')).toBeNull();
    expect(mockRunAppProvision).not.toHaveBeenCalled();
  });

  it('never loses the code silently when the decision response is dropped mid-flight: says so and offers Reissue', async () => {
    seedPendingProvision();
    installRoutedFetch({ dropDecision: true });
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));

    const notice = await screen.findByTestId('claim-code-missing');
    expect(notice.textContent).toMatch(/response was lost/);
    expect(within(notice).getByRole('button', { name: 'Reissue claim code' })).toBeDefined();
  });

  it('shows the persistent notice with Reissue (not the 4s flash) when a proxy answers 504 to an apps:provision approve', async () => {
    seedPendingProvision();
    installRoutedFetch({ decisionStatus: 504 });
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));

    const notice = await screen.findByTestId('claim-code-missing');
    expect(notice.textContent).toMatch(/response was lost/);
    expect(within(notice).getByRole('button', { name: 'Reissue claim code' })).toBeDefined();
    expect(screen.queryByText('Decision failed (504)')).toBeNull();
    expect(screen.queryByTestId('revealed-claim-code')).toBeNull();
  });

  it('shows the notice when the server approves but returns no claim code', async () => {
    seedPendingProvision();
    mockRunAppProvision.mockResolvedValue({ ...succeededOutcome(''), claimCode: '' });
    installRoutedFetch();
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));

    const notice = await screen.findByTestId('claim-code-missing');
    expect(notice.textContent).toMatch(/returned no claim code/);
  });
});

describe('reissue claim code from /jin (#2707)', () => {
  it('Reissue on the dropped-response notice raises the reissueClaim proposal; approving it shows the same box', async () => {
    seedPendingProvision();
    // Provisioning finished behind the dropped response, so the ledger row is `succeeded` — which is
    // what makes the route raise a genuine reissue card rather than an ordinary provision one.
    mockGetStatus.mockResolvedValue({ slug: 'dykil', status: 'succeeded', appDid: 'did:imajin:dykil-app', repoUrl: 'https://github.com/ima-jin/dykil', secretsSet: [] });
    const spy = installRoutedFetch({ dropFirstDecision: true });
    mockRunAppProvision.mockResolvedValue(succeededOutcome(REISSUED_CODE));
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));
    const notice = await screen.findByTestId('claim-code-missing');

    fireEvent.click(within(notice).getByRole('button', { name: 'Reissue claim code' }));

    const reissueCall = await waitFor(() => {
      const call = spy.mock.calls.find(([url, init]) => url === '/api/apps/provision' && init?.method === 'POST');
      expect(call).toBeDefined();
      return call!;
    });
    expect(JSON.parse((reissueCall[1] as RequestInit).body as string)).toEqual({ slug: 'dykil', displayName: 'Dykil', reissueClaim: true });
    await approveDecision(await screen.findByRole('button', { name: 'Approve & reissue' }));
    const box = await screen.findByTestId('revealed-claim-code');
    expect(within(box).getByText(REISSUED_CODE)).toBeDefined();
    expect(within(box).getByText(`${globalThis.location.origin}/dykil/claim`)).toBeDefined();
    expect(screen.queryByTestId('claim-code-missing')).toBeNull();
  });

  it('the Provision app panel offers Reissue on an already-provisioned app; the raised card says "reissue" and approving it shows the box', async () => {
    mockGetStatus.mockResolvedValue({
      slug: 'dykil',
      status: 'succeeded',
      appDid: 'did:imajin:dykil-app',
      repoUrl: 'https://github.com/ima-jin/dykil',
      secretsSet: [],
    });
    mockRunAppProvision.mockResolvedValue(succeededOutcome(REISSUED_CODE));
    const spy = installRoutedFetch();
    render(
      <>
        <ProvisionAppPanel />
        <OperatorApprovalsPanel />
      </>,
    );
    await screen.findByTestId('provision-app-panel');
    fireEvent.change(screen.getByLabelText(/Slug/), { target: { value: 'dykil' } });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Dykil' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose provision' }));
    expect(await screen.findByText('Already provisioned')).toBeDefined();
    expect(mockGetSignInAudience).toHaveBeenCalledWith('did:imajin:dykil-app');

    fireEvent.click(screen.getByTestId('provision-reissue'));

    const approve = await screen.findByRole('button', { name: 'Approve & reissue' });
    expect(screen.getByText(/Reissue the claim code for/)).toBeDefined();
    const reissuePost = spy.mock.calls.filter(([url, init]) => url === '/api/apps/provision' && init?.method === 'POST').at(-1)!;
    expect(JSON.parse((reissuePost[1] as RequestInit).body as string)).toMatchObject({ slug: 'dykil', reissueClaim: true });
    expect(JSON.parse((reissuePost[1] as RequestInit).body as string)).not.toHaveProperty('signInAudience');

    await approveDecision(approve);
    const box = await screen.findByTestId('revealed-claim-code');
    expect(within(box).getByText(REISSUED_CODE)).toBeDefined();
    expect(within(box).getByText(`${globalThis.location.origin}/dykil/claim`)).toBeDefined();
    expect(within(box).getByRole('button', { name: 'Copy' })).toBeDefined();
  });

  it('after a reload the Provision app panel lists the approved provision; Reissue → approve shows the new code once (#2745)', async () => {
    const listed = { slug: 'dykil', appDid: 'did:imajin:dykil-app', repoUrl: 'https://github.com/ima-jin/dykil', claimed: false, updatedAt: new Date() };
    mockListSucceeded.mockResolvedValue([listed]);
    mockGetStatus.mockResolvedValue({ slug: 'dykil', status: 'succeeded', appDid: listed.appDid, repoUrl: listed.repoUrl, secretsSet: [] });
    mockRunAppProvision.mockResolvedValue(succeededOutcome(REISSUED_CODE));
    const spy = installRoutedFetch();
    render(
      <>
        <ProvisionAppPanel />
        <OperatorApprovalsPanel />
      </>,
    );

    // Nothing was proposed in this page state — the server list alone brings the control back.
    fireEvent.click(await screen.findByTestId('provisioned-app-reissue'));

    const approve = await screen.findByRole('button', { name: 'Approve & reissue' });
    const reissuePost = spy.mock.calls.filter(([url, init]) => url === '/api/apps/provision' && init?.method === 'POST').at(-1)!;
    expect(JSON.parse((reissuePost[1] as RequestInit).body as string)).toMatchObject({ slug: 'dykil', reissueClaim: true });

    await approveDecision(approve);
    const box = await screen.findByTestId('revealed-claim-code');
    expect(within(box).getByText(REISSUED_CODE)).toBeDefined();
    expect(within(box).getByText(`${globalThis.location.origin}/dykil/claim`)).toBeDefined();
  });

  it('refuses a reissue for a slug with no succeeded run: 409, no card raised (#2745)', async () => {
    mockGetStatus.mockResolvedValue(undefined);
    const spy = installRoutedFetch();
    render(<ProvisionAppPanel />);
    await screen.findByTestId('provision-app-panel');

    const res = (await spy('/api/apps/provision', {
      method: 'POST',
      body: JSON.stringify({ slug: 'learn', displayName: 'Learn', reissueClaim: true }),
    })) as Response;

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nothing to reissue for learn' });
    expect(mockRecordRequested).not.toHaveBeenCalled();
    expect(mockRunAppProvision).not.toHaveBeenCalled();
  });

  it('does not offer Reissue until the app is actually provisioned', async () => {
    installRoutedFetch();
    render(<ProvisionAppPanel />);
    await screen.findByTestId('provision-app-panel');
    fireEvent.change(screen.getByLabelText(/Slug/), { target: { value: 'dykil' } });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Dykil' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose provision' }));
    await screen.findByTestId('provision-result');

    expect(screen.queryByTestId('provision-reissue')).toBeNull();
  });
});

describe('claim code is never logged or persisted (#2707)', () => {
  it('appears only in the one approve response and the in-memory banner', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    seedPendingProvision();
    installRoutedFetch();
    render(<OperatorApprovalsPanel />);
    await approveDecision(await screen.findByRole('button', { name: 'Approve & provision' }));
    await screen.findByTestId('revealed-claim-code');
    await screen.findByText('approved — pending apply');

    // The wire: the code rides ONLY in `data`; the card echoed back (a mirror of the persisted row) never carries it.
    const body = JSON.parse(lastDecisionBody) as { approval: unknown; data: { claimCode: string } };
    expect(body.data.claimCode).toBe(CLAIM_CODE);
    expect(JSON.stringify(body.approval)).not.toContain(CLAIM_CODE);

    // Persisted state: the approvals row the list serves, and browser storage.
    expect(JSON.stringify(cards)).not.toContain(CLAIM_CODE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CLAIM_CODE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CLAIM_CODE);

    // Logs, server (kernel logger) and client (console).
    for (const spy of [...Object.values(logSpies), ...consoleSpies]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CLAIM_CODE);
    }
    for (const code of SECRET_CODES) {
      expect(JSON.stringify(mockRecordRequested.mock.calls)).not.toContain(code);
      expect(JSON.stringify(mockDecide.mock.calls)).not.toContain(code);
    }
  });
});
