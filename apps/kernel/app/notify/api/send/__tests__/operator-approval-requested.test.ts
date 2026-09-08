/**
 * Tests for the `operator.approval.requested` scope in POST /notify/api/send
 * (#2059): the payload validation boundary (secret rejection, acceptance
 * (e)), the "must be addressed to the configured operator DID" guard, and
 * that a valid request persists the proposal lifecycle row alongside the
 * notification. Kept separate from route.test.ts (which never exercises
 * this scope) so each suite's mocks stay minimal — mirrors the existing
 * `deny.test.ts` next to `route.test.ts` convention for the GitHub confirm
 * route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPERATOR_DID, PROPOSAL_ID } from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockInsertValues, mockSelectLimit, mockRecordApprovalRequested, mockGetOperatorDid } = vi.hoisted(() => ({
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
  mockSelectLimit: vi.fn().mockResolvedValue([]),
  mockRecordApprovalRequested: vi.fn().mockResolvedValue(undefined),
  mockGetOperatorDid: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    insert: vi.fn(() => ({ values: mockInsertValues })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  },
  notifications: {},
  preferences: { did: 'did', scope: 'scope' },
  identities: { id: 'id', contactEmail: 'contact_email' },
  profiles: { did: 'did', contactEmail: 'contact_email' },
  credentials: { did: 'did', type: 'type', value: 'value' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'abcdefgh12345678' }));

vi.mock('@imajin/logger', () => ({
  withLogger: (
    _service: string,
    handler: (req: unknown, ctx: unknown) => Promise<Response>,
  ) => (req: unknown) =>
    handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, correlationId: 'cor_test' }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/email', () => ({ sendEmail: vi.fn() }));

// The real templates module — its operator.approval.requested entry is part
// of what this suite verifies gets used (title/body rendering).
vi.mock('@/src/lib/notify/ws-push', () => ({
  buildNotificationFrame: (input: Record<string, unknown>) => ({ type: 'notification', ...input }),
  pushNotificationToDid: vi.fn().mockResolvedValue(false),
}));

// operator-approvals.ts imports node-identity.ts, which calls getClient() at
// module scope (requires DATABASE_URL). Stub it so importOriginal() below can
// load the real (pure) validator/isOperatorIdentity code without a DB.
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  recordApprovalRequested: mockRecordApprovalRequested,
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

type RouteRequest = Parameters<typeof POST>[0];

const WEBHOOK_SECRET = 'notify-webhook-secret';

function makeReq(body: unknown): RouteRequest {
  const headers = new Headers();
  headers.set('x-webhook-secret', WEBHOOK_SECRET);
  return { headers, json: async () => body } as unknown as RouteRequest;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    to: OPERATOR_DID,
    scope: 'operator.approval.requested',
    data: {
      proposalId: PROPOSAL_ID,
      kind: 'restart',
      summary: 'Restart the gateway to load the updated plugin.',
      keysTouched: ['gateway.plugins.openclaw.version'],
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOTIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockInsertValues.mockResolvedValue(undefined);
  mockSelectLimit.mockResolvedValue([]);
  mockRecordApprovalRequested.mockResolvedValue(undefined);
});

describe('operator.approval.requested boundary in POST /notify/api/send (#2059)', () => {
  it('accepts a well-formed proposal, stores the notification, and records the lifecycle row', async () => {
    const res = await POST(makeReq(validBody()));

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledOnce();
    expect(mockRecordApprovalRequested).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      operatorDid: OPERATOR_DID,
      kind: 'restart',
      summary: 'Restart the gateway to load the updated plugin.',
      keysTouched: ['gateway.plugins.openclaw.version'],
      notificationId: 'ntf_abcdefgh12345678',
    });
  });

  it('rejects (400) when addressed to a DID other than the configured operator', async () => {
    const res = await POST(makeReq({ ...validBody(), to: 'did:imajin:someone-else' }));

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('rejects (400) when no operator DID is configured on this node at all', async () => {
    mockGetOperatorDid.mockResolvedValueOnce(null);

    const res = await POST(makeReq(validBody()));

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects (400) an unknown proposal kind', async () => {
    const res = await POST(makeReq(validBody({ kind: 'reboot-everything' })));
    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects (400) a summary containing a secret value (#2059 acceptance (e))', async () => {
    const res = await POST(makeReq(validBody({ summary: 'New token: Bearer sk-abcdefghijklmnop' })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/secret values/);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects (400) a keysTouched entry carrying a resolved SecretRef-shaped value (#2059 acceptance (e))', async () => {
    const res = await POST(
      makeReq(validBody({ keysTouched: [{ path: 'gateway.token', value: 'ghp_abcdefghijklmnopqrstuvwx0123456789' }] })),
    );
    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });
});
