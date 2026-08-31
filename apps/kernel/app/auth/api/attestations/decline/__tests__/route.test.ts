/**
 * Tests for POST /auth/api/attestations/decline.
 *
 * #1790 (amendment-by-supersession): declining a pending v2 amendment is
 * already just the existing pending-only decline path applied to that row —
 * v1 is a separate record that this route never touches, so "decline of v2
 * -> v1 stands" falls out for free. These tests pin that behavior, plus the
 * pre-existing guard that already makes bilateral attestations immune to
 * unilateral decline (attestationStatus !== 'pending' -> 409).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SUBJECT_DID = 'did:imajin:bob';
const ATTESTATION_ID = 'att_v2_proposed';
const V1_ID = 'att_v1_bilateral';

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextRequest: Request,
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      }),
  },
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: h.mockSelectLimit }) }) }),
    update: () => ({ set: () => ({ where: h.mockUpdateWhere }) }),
  },
  attestations: {},
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args }));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@/src/lib/auth/middleware', () => ({ requireAuth: h.requireAuth }));

import { POST } from '../route';

function declineRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/auth/api/attestations/decline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function pendingAmendment(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTESTATION_ID,
    subjectDid: SUBJECT_DID,
    supersedes: V1_ID,
    attestationStatus: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockSelectLimit.mockReset();
  h.mockUpdateWhere.mockReset();
  h.mockUpdateWhere.mockResolvedValue(undefined);
  h.requireAuth.mockResolvedValue({ sub: SUBJECT_DID });
});

describe('POST /auth/api/attestations/decline — amendment-by-supersession (#1790)', () => {
  it('declines a pending v2 amendment and never touches v1 (decline only ever updates the id it was called with)', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);

    const res = await POST(declineRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: ATTESTATION_ID, status: 'declined' });

    // Only one update call, targeting v2's own id — v1 is a separate row
    // this route has no code path that ever reaches.
    expect(h.mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('is immune to declining an already-bilateral attestation (explicit pending-only guard)', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment({ attestationStatus: 'bilateral' })]);

    const res = await POST(declineRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/bilateral/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('is immune to declining an already-superseded attestation', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment({ attestationStatus: 'superseded' })]);

    const res = await POST(declineRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(409);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects a decline attempt from someone other than the subject', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.requireAuth.mockResolvedValue({ sub: 'did:imajin:mallory' });

    const res = await POST(declineRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(403);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });
});
