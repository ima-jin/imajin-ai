import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROPOSAL_ID } from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

const { mockMarkApplied } = vi.hoisted(() => ({ mockMarkApplied: vi.fn() }));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  markApplied: mockMarkApplied,
}));

import { POST, OPTIONS } from '../route';

const WEBHOOK_SECRET = 'notify-webhook-secret';

function makeReq(body: unknown, opts: { secret?: string | null } = {}): Request {
  const headers = new Headers();
  const secret = opts.secret === undefined ? WEBHOOK_SECRET : opts.secret;
  if (secret !== null) headers.set('x-webhook-secret', secret);
  return new Request('https://test.imajin.ai/notify/api/internal/operator-approvals/applied', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOTIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  mockMarkApplied.mockResolvedValue({ ok: true });
});

describe('OPTIONS /notify/api/internal/operator-approvals/applied', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq({}) as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('POST /notify/api/internal/operator-approvals/applied (#2059)', () => {
  it('returns 401 when the webhook secret is missing or wrong', async () => {
    const res = await POST(makeReq({ proposalId: PROPOSAL_ID }, { secret: 'wrong' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(mockMarkApplied).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await POST(makeReq('not json') as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('returns 400 when proposalId is missing', async () => {
    const res = await POST(makeReq({}) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockMarkApplied).not.toHaveBeenCalled();
  });

  it('marks the proposal applied and returns the service result', async () => {
    const res = await POST(makeReq({ proposalId: PROPOSAL_ID }) as Parameters<typeof POST>[0]);
    expect(mockMarkApplied).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('is idempotent — a second call for an already-applied proposal still succeeds', async () => {
    mockMarkApplied.mockResolvedValueOnce({ ok: true });
    const res = await POST(makeReq({ proposalId: PROPOSAL_ID }) as Parameters<typeof POST>[0]);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reports ok:false for a proposal that is not currently approved', async () => {
    mockMarkApplied.mockResolvedValueOnce({ ok: false });
    const res = await POST(makeReq({ proposalId: PROPOSAL_ID }) as Parameters<typeof POST>[0]);
    expect(await res.json()).toEqual({ ok: false });
  });
});
