/**
 * Tests for GET/POST /api/admin/keys/rotation (#2081): admin gating and the
 * mapping from the node-key-rotation library's results to HTTP responses.
 * The library itself is covered in src/lib/auth/__tests__/node-key-rotation.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  recordKeyRotation: vi.fn(),
  verifyNodeKeyHistory: vi.fn(),
  log: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: h.requireAdmin }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: h.log, error: h.log, info: h.log }),
}));
vi.mock('@/src/lib/auth/node-key-rotation', () => ({
  recordKeyRotation: h.recordKeyRotation,
  verifyNodeKeyHistory: h.verifyNodeKeyHistory,
}));

import { GET, POST } from '../route';

function getRequest(query = ''): NextRequest {
  return { nextUrl: new URL(`http://localhost/api/admin/keys/rotation${query}`) } as unknown as NextRequest;
}

function postRequest(body: () => Promise<unknown>): NextRequest {
  return { json: body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ did: 'did:imajin:admin' });
});

describe('GET /api/admin/keys/rotation', () => {
  it('rejects a non-admin without touching the node', async () => {
    h.requireAdmin.mockResolvedValue(null);

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(h.verifyNodeKeyHistory).not.toHaveBeenCalled();
  });

  it('returns the history report as-is, 200 even when the check fails', async () => {
    const report = { ok: false, errors: ['key history ends at auth-1'], warnings: [], nodeDid: 'did:imajin:n', currentKid: 'auth-2', rotations: 1, history: [] };
    h.verifyNodeKeyHistory.mockResolvedValue(report);

    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...report, processStartedAt: new Date(performance.timeOrigin).toISOString() });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.verifyNodeKeyHistory).toHaveBeenCalledWith({ anchorPublicKey: undefined });
  });

  it('passes ?anchor= through as the pinned genesis key', async () => {
    h.verifyNodeKeyHistory.mockResolvedValue({ ok: true });

    await GET(getRequest('?anchor=abcd'));

    expect(h.verifyNodeKeyHistory).toHaveBeenCalledWith({ anchorPublicKey: 'abcd' });
  });

  it('answers 500 without leaking the error when verification throws', async () => {
    const sentinel = randomBytes(32).toString('base64');
    h.verifyNodeKeyHistory.mockRejectedValue(new Error(sentinel));

    const res = await GET(getRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Node key history verification failed' });
    expect(JSON.stringify(h.log.mock.calls).includes(sentinel)).toBe(false);
  });
});

describe('POST /api/admin/keys/rotation', () => {
  const payload = {
    oldKid: 'a', newKid: 'b', oldPublicKey: 'public-old', newPublicKey: 'public-new',
    effectiveAt: '2026-10-06T12:00:00.000Z', oldKeySignature: 'public-signature', newKeySignature: 'public-signature',
  };

  it.each([null, [], {}, { ...payload, extra: 'OBVIOUSLY_FAKE_INPUT' }])('rejects non-public upload shapes before storage', async (body) => {
    const res = await POST(postRequest(async () => body));
    expect(res.status).toBe(400);
    expect(h.recordKeyRotation).not.toHaveBeenCalled();
  });

  it('does not return extra uploaded private input', async () => {
    const sentinel = randomBytes(32).toString('base64');
    const res = await POST(postRequest(async () => ({ ...payload, privateKey: sentinel })));
    expect(res.status).toBe(400);
    expect((await res.text()).includes(sentinel)).toBe(false);
    expect(h.recordKeyRotation).not.toHaveBeenCalled();
  });

  it('rejects a non-admin without reading the body', async () => {
    h.requireAdmin.mockResolvedValue(null);
    const json = vi.fn();

    const res = await POST(postRequest(json));

    expect(res.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(h.recordKeyRotation).not.toHaveBeenCalled();
  });

  it('answers 400 on a body that is not JSON', async () => {
    const res = await POST(postRequest(() => Promise.reject(new SyntaxError('bad'))));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    expect(h.recordKeyRotation).not.toHaveBeenCalled();
  });

  it('answers 201 with the minted attestation and never echoes the signatures', async () => {
    h.recordKeyRotation.mockResolvedValue({
      ok: true,
      attestationId: 'att_1',
      oldKid: 'a',
      newKid: 'b',
      effectiveAt: '2026-10-06T12:00:00.000Z',
    });

    const res = await POST(postRequest(async () => payload));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      attestationId: 'att_1',
      oldKid: 'a',
      newKid: 'b',
      effectiveAt: '2026-10-06T12:00:00.000Z',
    });
    expect(h.recordKeyRotation).toHaveBeenCalledWith(payload);
  });

  it.each([400, 409, 500] as const)('maps a library rejection to its %i status', async (status) => {
    h.recordKeyRotation.mockResolvedValue({ ok: false, status, error: 'because' });

    const res = await POST(postRequest(async () => payload));

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'because' });
  });

  it('answers 500 without leaking the error when recording throws', async () => {
    const sentinel = randomBytes(32).toString('base64');
    h.recordKeyRotation.mockRejectedValue(new Error(sentinel));

    const res = await POST(postRequest(async () => payload));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Recording node key rotation failed' });
    expect(JSON.stringify(h.log.mock.calls).includes(sentinel)).toBe(false);
  });
});
