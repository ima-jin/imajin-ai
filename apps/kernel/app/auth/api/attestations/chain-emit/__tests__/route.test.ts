import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const h = vi.hoisted(() => ({ auth: vi.fn(), emit: vi.fn() }));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: h.auth }));
vi.mock('@/src/lib/auth/dfos', () => ({ createAttestationEntry: h.emit }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { POST } from '../route';
function request(type: unknown): NextRequest {
  return new NextRequest('http://localhost/auth/api/attestations/chain-emit', {
    method: 'POST', body: JSON.stringify({ issuer_did: 'did:issuer', subject_did: 'did:subject', type }),
    headers: { 'Content-Type': 'application/json' },
  });
}
beforeEach(() => { vi.clearAllMocks(); h.auth.mockResolvedValue(null); h.emit.mockResolvedValue(true); });
it.each(['domain.verified', 'domain.revoked', 'key.rotated'])('rejects %s before publishing any relay chain', async (type) => {
  expect((await POST(request(type))).status).toBe(403);
  expect(h.emit).not.toHaveBeenCalled();
});
it('preserves ordinary attestation chain emission', async () => {
  const response = await POST(request('vouch'));
  expect(response.status).toBe(200);
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'vouch' }));
});
it('preserves fail-closed shared authentication', async () => {
  h.auth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
  expect((await POST(request('vouch'))).status).toBe(401);
  expect(h.emit).not.toHaveBeenCalled();
});
it('preserves type shape validation', async () => {
  expect((await POST(request(null))).status).toBe(400);
  expect(h.emit).not.toHaveBeenCalled();
});
