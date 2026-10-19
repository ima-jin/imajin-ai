// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { OperatorApprovalsPanel, canonicalizeCountersignFields, type OperatorApprovalCard } from '../operator-approvals-panel';
import { ReachApprovalActions, ReachApprovalDetail, isReachApproval } from '../reach-approval-card';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

function card(source = 'reach'): OperatorApprovalCard {
  return {
    proposalId: 'inbox_1', source, kind: source === 'reach' ? 'reach:message' : 'knock:request',
    summary: 'Incoming message', keysTouched: [], contentHash: 'a'.repeat(64),
    detail: {
      principalDid: 'did:imajin:ryan', requesterDid: 'did:imajin:alice-agent',
      requesterTier: 'external', topic: 'collaboration', message: 'Can we work together?',
      onBehalfOf: { platform: 'Muse', externalRef: 'Alice', selfDescription: 'Design partner' },
      claimVerified: false, transcriptHash: 'b'.repeat(64),
      rules: 'PRIVATE GATE', unpublishedTopics: ['PRIVATE TOPIC'],
    },
    status: 'pending', decision: null, outcome: null, appliedAt: null,
    createdAt: '2026-10-01T12:00:00.000Z',
  };
}

function inbox(approval = card(), context: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url.endsWith('/decision')) return { ok: true, json: async () => ({ approval }) };
    return { ok: true, json: async () => ({ isOperator: false, approvals: [approval], ...context }) };
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

beforeEach(async () => {
  await Promise.all([import('@noble/ed25519'), import('@noble/hashes/sha2.js')]);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(['reach', 'knock'])('%s Inbox evidence', source => {
  it('shows message, requester, tier, hash, and explicitly unverified claim without leaking arbitrary fields', async () => {
    inbox(card(source));
    render(<OperatorApprovalsPanel />);
    expect(await screen.findByText("Alice's agent (Muse, unverified claim) about collaboration")).toBeDefined();
    expect(screen.getByText('Can we work together?')).toBeDefined();
    expect(screen.getByText('did:imajin:alice-agent')).toBeDefined();
    expect(screen.getByText('external')).toBeDefined();
    expect(screen.getByText('b'.repeat(64))).toBeDefined();
    expect(screen.getByText('UNVERIFIED onBehalfOf claim')).toBeDefined();
    expect(screen.getByText('Design partner')).toBeDefined();
    expect(screen.queryByText('PRIVATE GATE')).toBeNull();
    expect(screen.queryByText('PRIVATE TOPIC')).toBeNull();
    for (const name of ['Reply', 'Accept thread', 'Decline', 'Block']) {
      expect(screen.getByRole('button', { name })).toBeDefined();
    }
    expect(document.querySelector('a[href*="/auth/agents"]')).toBeNull();
  });
});

describe.each([
  ['Block', 'block'], ['Decline', 'decline'], ['Accept thread', 'accept'], ['Sign & send reply', 'reply'],
])('signed %s command', (button, mode) => {
  it('uses the shared decision route and a real signature covering the action and reply bytes', async () => {
    const keypair = authCrypto.generateKeypair();
    localStorage.setItem('imajin_keypair', JSON.stringify(keypair));
    const fetcher = inbox();
    render(<OperatorApprovalsPanel />);
    await screen.findByRole('button', { name: 'Reply' });
    if (mode === 'reply') {
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello Alice — yes.' } });
    }
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('/decision'))).toBe(true));
    const request = fetcher.mock.calls.find(([url]) => url.endsWith('/decision'));
    const body = JSON.parse(String(request?.[1]?.body));
    expect(request?.[0]).toBe('/jin/api/operator-approvals/inbox_1/decision');
    expect(body).toMatchObject({
      decision: 'approve', mode,
      operatorSignature: { alg: 'ed25519', keyId: keypair.publicKey },
    });
    const fields = {
      contentHash: 'a'.repeat(64), decidedAt: body.decidedAt, decision: 'approve', mode,
      ...(mode === 'reply' ? { replyMessage: 'Hello Alice — yes.' } : {}),
    };
    expect(body.replyMessage).toBe(mode === 'reply' ? 'Hello Alice — yes.' : undefined);
    expect(canonicalizeCountersignFields(fields)).toBe(canonicalize(fields));
    expect(authCrypto.verifySync(body.operatorSignature.sig, canonicalize(fields), keypair.publicKey)).toBe(true);
    if (mode === 'reply') {
      expect(authCrypto.verifySync(body.operatorSignature.sig, canonicalize({ ...fields, replyMessage: 'tampered' }), keypair.publicKey)).toBe(false);
    }
  });
});

it('never submits an unsigned Reach action when the browser has no key', async () => {
  const fetcher = inbox();
  render(<OperatorApprovalsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
  expect(await screen.findByText(/Your own signing key is required/)).toBeDefined();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/decision'))).toBe(false);
});

it('unlocks only server-verified admin Reach act-as cards', async () => {
  inbox(card(), { actAs: { sessionDid: 'did:imajin:admin', actingDid: 'did:imajin:ryan' }, reachActAsAllowed: true });
  render(<OperatorApprovalsPanel />);
  expect(await screen.findByRole('button', { name: 'Block' })).toBeDefined();
  expect(screen.getByTestId('act-as-readonly-notice').textContent).toContain('Reach/knock admin actions allowed');
});

it('keeps non-admin act-as Reach cards read-only', async () => {
  inbox(card(), { actAs: { sessionDid: 'did:imajin:other', actingDid: 'did:imajin:ryan' } });
  render(<OperatorApprovalsPanel />);
  expect(await screen.findByTestId('act-as-locked')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
});

it('never unlocks other approval kinds with the Reach admin exception', async () => {
  inbox({ ...card(), source: 'system-agent', kind: 'system-agent:restart' }, {
    actAs: { sessionDid: 'did:imajin:admin', actingDid: 'did:imajin:ryan' }, reachActAsAllowed: true,
  });
  render(<OperatorApprovalsPanel />);
  expect(await screen.findByTestId('act-as-locked')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('renders missing/malformed evidence safely and only links a valid accepted DM', () => {
  const approval = { ...card(), detail: null, outcome: { conversationDid: 'javascript:alert(1)' } };
  const { rerender } = render(<ReachApprovalDetail approval={approval} />);
  expect(screen.getByRole('heading').textContent).toContain('unknown platform');
  expect(screen.queryByRole('link')).toBeNull();
  rerender(<ReachApprovalDetail approval={{ ...approval, outcome: { conversationDid: 'did:imajin:dm:0123456789abcdef' } }} />);
  expect(screen.getByRole('link').getAttribute('href')).toBe('/chat/conversations/dm/0123456789abcdef');
});

it('disables all actions while signing and forbids blank replies', () => {
  const { rerender } = render(<ReachApprovalActions approval={card()} onDecide={vi.fn()} busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
  expect((screen.getByRole('button', { name: 'Sign & send reply' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ReachApprovalActions approval={card()} onDecide={vi.fn()} busy />);
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
});

it('recognizes only the two Inbox source/kind pairs', () => {
  expect(isReachApproval(card())).toBe(true);
  expect(isReachApproval(card('knock'))).toBe(true);
  expect(isReachApproval({ source: 'reach', kind: 'reach:other' })).toBe(false);
});

it('announces the signed action using native output and removes completed controls', async () => {
  inbox({
    ...card(), status: 'applied',
    decision: { decidedBy: 'did:imajin:ryan', decidedAt: '2026-10-18T12:00:00.000Z', mode: 'block' },
  });
  render(<OperatorApprovalsPanel />);
  const result = await screen.findByRole('status');
  expect(result.tagName).toBe('OUTPUT');
  expect(result.textContent).toBe('Signed action: block');
  expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
});
