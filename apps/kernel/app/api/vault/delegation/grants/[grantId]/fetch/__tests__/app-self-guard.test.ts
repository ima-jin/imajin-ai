import { beforeEach, expect, it, vi } from 'vitest';
const { fetchSecret, getGrant, auth } = vi.hoisted(() => ({
  fetchSecret: vi.fn(), getGrant: vi.fn(), auth: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAuth: auth, authErrorResponse: vi.fn() }));
vi.mock('@/src/lib/vault', () => ({ fetchGrantSecret: fetchSecret, getGrantById: getGrant }));
vi.mock('@/src/lib/vault/route-helpers', () => ({
  publishVaultDelegationAudit: vi.fn(), GRANT_NOT_FOUND_STATUS: 404, GRANT_NOT_FOUND_ERROR: 'Not found',
}));
vi.mock('@/src/lib/vault/errors', () => ({ toVaultErrorResponse: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
import { POST } from '../route';
beforeEach(() => { vi.clearAllMocks(); auth.mockResolvedValue({ identity: { id: 'did:imajin:app-test' } }); });
it('refuses app-self metadata before plaintext decrypt or grant consumption', async () => {
  getGrant.mockResolvedValue({ field: 'internal-secret:app-self:did:imajin:app-test:SESSION_SECRET' });
  const response = await POST(new Request('https://kernel.example'), { params: Promise.resolve({ grantId: 'test-grant' }) });
  expect(response.status).toBe(403);
  expect(fetchSecret).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('preserves legacy plaintext grant fetching for other fields', async () => {
  getGrant.mockResolvedValue({ field: 'internal-secret:legacy-test' });
  fetchSecret.mockResolvedValue({ status: 'ok', value: 'FAKE_LEGACY_SECRET', grant: {
    field: 'internal-secret:legacy-test', purpose: 'legacy', oneTime: false, expiresAt: null,
  } });
  const response = await POST(new Request('https://kernel.example'), { params: Promise.resolve({ grantId: 'test-grant' }) });
  expect(response.status).toBe(200);
  expect(fetchSecret).toHaveBeenCalledOnce();
});
it('redacts metadata lookup failures without attempting decrypt', async () => {
  getGrant.mockRejectedValue(new Error('FAKE_TEST_SECRET'));
  const response = await POST(new Request('https://kernel.example'), { params: Promise.resolve({ grantId: 'test-grant' }) });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('FAKE_TEST_SECRET');
  expect(fetchSecret).not.toHaveBeenCalled();
});
