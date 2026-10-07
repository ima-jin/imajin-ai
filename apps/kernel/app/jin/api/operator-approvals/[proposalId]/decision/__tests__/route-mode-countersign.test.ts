/**
 * #2693 end to end: the REAL decision route, REAL service, REAL
 * countersignature verification and REAL Ed25519 — only the database, the
 * bus, auth and the downstream executors are stubbed. This is the
 * operator's-seat proof that
 *   - the signature covers the chosen option for every approval kind that
 *     carries one (decision-card letter, exec allow-once, github TTL),
 *   - a mode altered / added / dropped after signing is refused (400),
 *   - a mode the card never offered is refused (400) before verification,
 *   - a decision signed in the pre-#2693 shape (no mode) still goes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crypto as authCrypto, canonicalize } from '@imajin/auth';
import {
  OPERATOR_DID,
  PROPOSAL_ID,
  operatorIdentity,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

const { mockRequireAuth, mockLimit, mockUpdateSet, mockPublish, nodeKeys } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockLimit: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  nodeKeys: { privateKeyHex: '', senderPubkey: '' },
}));

vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: mockRequireAuth };
});

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) })),
    update: vi.fn(() => ({ set: (values: unknown) => { mockUpdateSet(values); return { where: vi.fn().mockResolvedValue(undefined) }; } })),
  },
  operatorApprovals: { proposalId: 'proposal_id', operatorDid: 'operator_did', source: 'source', status: 'status', createdAt: 'created_at' },
  identities: { id: 'id', publicKey: 'public_key', scope: 'scope', tier: 'tier' },
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => nodeKeys }));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn() }));
vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: vi.fn().mockResolvedValue(OPERATOR_DID) };
});
vi.mock('@/src/lib/vault/approvals-execution', () => ({ executeVaultApproval: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@/src/lib/access/approvals-execution', () => ({ executeAccessApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }) }));
vi.mock('@/src/lib/apps/approvals-execution', () => ({ executeAppsProvisionApproval: vi.fn().mockResolvedValue({ ok: true, data: {} }) }));
vi.mock('@/src/lib/github/approvals-execution', () => ({
  executeGithubApproval: vi.fn().mockResolvedValue({ ok: true }),
  GITHUB_SOURCE: 'github',
}));

import { POST } from '../route';
import { effectiveContentHash } from '@/src/lib/notify/operator-approvals';
import { EXEC_COMMAND_KIND, EXEC_COMMAND_SOURCE } from '@/src/lib/notify/exec-command-approvals';
import { assessDecidedModeCountersignature } from '@/src/lib/notify/operator-countersign-fields';

const operator = authCrypto.generateKeypair();
const nodeKeypair = authCrypto.generateKeypair();
nodeKeys.privateKeyHex = nodeKeypair.privateKey;
nodeKeys.senderPubkey = nodeKeypair.publicKey;

function baseRow(overrides: Record<string, unknown>) {
  return {
    proposalId: PROPOSAL_ID,
    operatorDid: OPERATOR_DID,
    source: 'system-agent',
    kind: 'system-agent:restart',
    summary: 'A proposal',
    keysTouched: [],
    detail: null,
    contentHash: null,
    notificationId: null,
    signerDid: null,
    status: 'pending',
    decision: null,
    outcome: null,
    appliedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

const cardRow = () =>
  baseRow({
    source: 'decision',
    kind: 'decision:card',
    detail: {
      subject: { kind: 'pr', ref: 'ima-jin/imajin-ai#2693', url: 'https://example.test/pr/2693' },
      question: 'Merge?',
      options: [
        { letter: 'a', label: 'Merge', consequence: 'ships' },
        { letter: 'b', label: 'Hold', consequence: 'waits' },
      ],
      rec: { letter: 'a', why: 'green' },
    },
  });
const execRow = () =>
  baseRow({
    source: EXEC_COMMAND_SOURCE,
    kind: EXEC_COMMAND_KIND,
    detail: { command: 'ls', host: 'h', cwd: '/', expiresAt: new Date(Date.now() + 300_000).toISOString() },
  });
const githubRow = () => baseRow({ source: 'github', kind: 'github:mutate', detail: { tool: 'create_issue' } });
const genericRow = () => baseRow({});

/** The operator's client: signs `{contentHash, decidedAt, decision[, mode]}` with their own key. */
function signedBody(row: ReturnType<typeof baseRow>, signed: { decision: string; mode?: string }, sent: { decision: string; mode?: string }) {
  const decidedAt = new Date().toISOString();
  const contentHash = effectiveContentHash(row as never);
  const signedFields = {
    contentHash,
    decidedAt,
    decision: signed.decision,
    ...(signed.mode === undefined ? {} : { mode: signed.mode }),
  };
  const sig = authCrypto.signSync(canonicalize(signedFields), operator.privateKey);
  return {
    decision: sent.decision,
    ...(sent.mode === undefined ? {} : { mode: sent.mode }),
    decidedAt,
    operatorSignature: { keyId: operator.publicKey, alg: 'ed25519', sig },
  };
}

async function post(body: unknown) {
  const req = new Request(`https://test.imajin.ai/jin/api/operator-approvals/${PROPOSAL_ID}/decision`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const res = await POST(req as Parameters<typeof POST>[0], { params: Promise.resolve({ proposalId: PROPOSAL_ID }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Queue the DB reads a decide makes: the approval row, then (if reached) the operator's registered key, then the fresh row. */
function queueReads(row: ReturnType<typeof baseRow>) {
  mockLimit
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce([{ id: OPERATOR_DID, publicKey: operator.publicKey, type: 'actor', tier: 'established' }])
    .mockResolvedValueOnce([{ ...row, status: 'approved' }]);
}

function persistedPayload() {
  const values = mockUpdateSet.mock.calls[0]?.[0] as { decision: { payload: Record<string, unknown> } } | undefined;
  return values?.decision.payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLimit.mockReset();
  mockRequireAuth.mockResolvedValue({ identity: operatorIdentity() });
  mockPublish.mockResolvedValue(undefined);
});

describe('round trip — the operator signature covers the chosen mode, per kind (#2693)', () => {
  it.each([
    { name: 'decision:card letter b', row: cardRow, mode: 'b' },
    { name: 'exec allow-once', row: execRow, mode: 'allow-once' },
    { name: 'github TTL 5m', row: githubRow, mode: '5m' },
    { name: 'github TTL 24h', row: githubRow, mode: '24h' },
    { name: 'github TTL single', row: githubRow, mode: 'single' },
  ])('$name: accepted, persisted with the mode, and the stored decision verifies as countersigned', async ({ row, mode }) => {
    const r = row();
    queueReads(r);

    const { status } = await post(signedBody(r, { decision: 'approve', mode }, { decision: 'approve', mode }));

    expect(status).toBe(200);
    const payload = persistedPayload();
    expect(payload).toMatchObject({ decision: 'approve', mode });
    expect(assessDecidedModeCountersignature(payload)).toBe('countersigned');
  });

  it('exec deny on reject round-trips too', async () => {
    const r = execRow();
    queueReads(r);

    const { status } = await post(signedBody(r, { decision: 'reject', mode: 'deny' }, { decision: 'reject', mode: 'deny' }));

    expect(status).toBe(200);
    expect(assessDecidedModeCountersignature(persistedPayload())).toBe('countersigned');
  });
});

describe('tampering — a mode that does not match what was signed is refused (400)', () => {
  it.each([
    { name: 'card letter swapped after signing (signed a, sent b)', row: cardRow, signed: { decision: 'approve', mode: 'a' }, sent: { decision: 'approve', mode: 'b' } },
    { name: 'github TTL widened after signing (signed 5m, sent 24h)', row: githubRow, signed: { decision: 'approve', mode: '5m' }, sent: { decision: 'approve', mode: '24h' } },
    { name: 'mode added to a mode-less signature (stale client)', row: cardRow, signed: { decision: 'approve' }, sent: { decision: 'approve', mode: 'a' } },
    { name: 'exec mode added to a mode-less signature', row: execRow, signed: { decision: 'approve' }, sent: { decision: 'approve', mode: 'allow-once' } },
    { name: 'mode dropped after signing (signed a, sent none)', row: githubRow, signed: { decision: 'approve', mode: '5m' }, sent: { decision: 'approve' } },
  ])('$name', async ({ row, signed, sent }) => {
    const r = row();
    queueReads(r);

    const { status, body } = await post(signedBody(r, signed, sent));

    expect(status).toBe(400);
    expect(body.error).toBe('Invalid operator signature');
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('refusals — a mode the kind does not offer is refused (400), even when validly signed', () => {
  it('decision:card — a letter that is not on the card', async () => {
    const r = cardRow();
    queueReads(r);

    const { status, body } = await post(signedBody(r, { decision: 'approve', mode: 'z' }, { decision: 'approve', mode: 'z' }));

    expect(status).toBe(400);
    expect(body.error).toMatch(/option letters \(a, b\)/);
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('decision:card — an approve that names no option', async () => {
    const r = cardRow();
    queueReads(r);

    const { status } = await post(signedBody(r, { decision: 'approve' }, { decision: 'approve' }));

    expect(status).toBe(400);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('github — an unknown TTL', async () => {
    const r = githubRow();
    queueReads(r);

    const { status, body } = await post(signedBody(r, { decision: 'approve', mode: 'forever' }, { decision: 'approve', mode: 'forever' }));

    expect(status).toBe(400);
    expect(body.error).toMatch(/'single', '5m', '24h'/);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('exec — allow-always', async () => {
    const r = execRow();
    queueReads(r);

    const { status, body } = await post(signedBody(r, { decision: 'approve', mode: 'allow-always' }, { decision: 'approve', mode: 'allow-always' }));

    expect(status).toBe(400);
    expect(body.error).toMatch(/allow-always/);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('a kind that defines no mode — any mode', async () => {
    const r = genericRow();
    queueReads(r);

    const { status } = await post(signedBody(r, { decision: 'approve', mode: 'allow-once' }, { decision: 'approve', mode: 'allow-once' }));

    expect(status).toBe(400);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it.each([{ mode: '' }, { mode: 5 }, { mode: null }, { mode: ['a'] }])('malformed mode %j never reaches the service', async (extra) => {
    const { status } = await post({ decision: 'approve', ...extra });

    expect(status).toBe(400);
    expect(mockLimit).not.toHaveBeenCalled();
  });
});

describe('back-compat — decisions in the pre-#2693 shape still verify as they did', () => {
  it('a mode-less decision signed over the original three fields is accepted', async () => {
    const r = genericRow();
    queueReads(r);

    const { status } = await post(signedBody(r, { decision: 'approve' }, { decision: 'approve' }));

    expect(status).toBe(200);
    const payload = persistedPayload();
    expect(payload).not.toHaveProperty('mode');
    expect(assessDecidedModeCountersignature(payload)).toBe('not-applicable');
  });

  it('an unsigned decision with a valid option is still accepted while the per-node flag is off (v1 behavior)', async () => {
    mockLimit.mockResolvedValueOnce([cardRow()]).mockResolvedValueOnce([{ ...cardRow(), status: 'approved' }]);

    const { status } = await post({ decision: 'approve', mode: 'a' });

    expect(status).toBe(200);
    // Nothing signed by the operator → nothing to call countersigned or invalid.
    expect(assessDecidedModeCountersignature(persistedPayload())).toBe('not-applicable');
  });
});
