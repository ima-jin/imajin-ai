import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROPOSAL_ID } from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

const { mockAttachApprovalOutcome } = vi.hoisted(() => ({ mockAttachApprovalOutcome: vi.fn() }));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  attachApprovalOutcome: mockAttachApprovalOutcome,
}));

import { POST, OPTIONS } from '../route';

const WEBHOOK_SECRET = 'notify-webhook-secret';

function makeReq(body: unknown, opts: { secret?: string | null } = {}): Request {
  const headers = new Headers();
  const secret = opts.secret === undefined ? WEBHOOK_SECRET : opts.secret;
  if (secret !== null) headers.set('x-webhook-secret', secret);
  return new Request('https://test.imajin.ai/notify/api/internal/operator-approvals/outcome', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_OUTCOME = { proposalId: PROPOSAL_ID, exitCode: 0, durationMs: 1234, outputHash: 'a'.repeat(64) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOTIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  mockAttachApprovalOutcome.mockResolvedValue({ ok: true });
});

describe('OPTIONS /notify/api/internal/operator-approvals/outcome', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq({}) as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('POST /notify/api/internal/operator-approvals/outcome (#2221)', () => {
  it('returns 401 when the webhook secret is missing or wrong', async () => {
    const res = await POST(makeReq(VALID_OUTCOME, { secret: 'wrong' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(mockAttachApprovalOutcome).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await POST(makeReq('not json') as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('returns 400 when proposalId is missing', async () => {
    const res = await POST(makeReq({ exitCode: 0, durationMs: 1, outputHash: 'a'.repeat(64) }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockAttachApprovalOutcome).not.toHaveBeenCalled();
  });

  it.each([
    ['missing exitCode', { ...VALID_OUTCOME, exitCode: undefined }],
    ['non-integer exitCode', { ...VALID_OUTCOME, exitCode: 1.5 }],
    ['missing durationMs', { ...VALID_OUTCOME, durationMs: undefined }],
    ['negative durationMs', { ...VALID_OUTCOME, durationMs: -1 }],
    ['missing outputHash', { ...VALID_OUTCOME, outputHash: undefined }],
    ['empty outputHash', { ...VALID_OUTCOME, outputHash: '' }],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await POST(makeReq(body) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockAttachApprovalOutcome).not.toHaveBeenCalled();
  });

  it('attaches the outcome and returns the service result', async () => {
    const res = await POST(makeReq(VALID_OUTCOME) as Parameters<typeof POST>[0]);
    expect(mockAttachApprovalOutcome).toHaveBeenCalledWith(PROPOSAL_ID, { exitCode: 0, durationMs: 1234, outputHash: 'a'.repeat(64) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 when the service reports the proposal was not found', async () => {
    mockAttachApprovalOutcome.mockResolvedValueOnce({ ok: false, error: 'Proposal not found' });
    const res = await POST(makeReq(VALID_OUTCOME) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(404);
  });

  it('returns 400 when the service rejects a non-exec.command kind', async () => {
    mockAttachApprovalOutcome.mockResolvedValueOnce({ ok: false, error: 'Outcome attachment is only supported for exec.command approvals' });
    const res = await POST(makeReq(VALID_OUTCOME) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });
});
