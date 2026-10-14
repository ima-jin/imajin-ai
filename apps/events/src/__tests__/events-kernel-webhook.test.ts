import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('@imajin/auth/kernel-webhook', async (importOriginal) => ({
  ...await importOriginal<typeof import('@imajin/auth/kernel-webhook')>(),
  verifyKernelWebhook: mocks.verify,
}));
import { KernelWebhookError } from '@imajin/auth/kernel-webhook';
import { kernelWebhookFailure, verifyEventsKernelWebhook } from '../lib/kernel-webhook';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:configured-test-app');
  vi.stubEnv('AUTH_SERVICE_URL', '');
  vi.stubEnv('AUTH_URL', '');
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.test/');
  mocks.verify.mockResolvedValue({ received: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('events verifier configuration and safe responses', () => {
  it('uses only local audience configuration and derives /auth from configured kernel URL', async () => {
    const request = new Request('https://events.test/api/webhook', {
      headers: { 'x-kernel-audience': 'did:imajin:untrusted-test-header' },
    });
    await verifyEventsKernelWebhook(request);
    expect(mocks.verify).toHaveBeenCalledWith(request, expect.objectContaining({
      audience: 'did:imajin:configured-test-app', authServiceUrl: 'https://kernel.test/auth',
    }));
  });

  it('prefers the configured auth service URL', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', 'https://configured.test/auth');
    await verifyEventsKernelWebhook(new Request('https://events.test/api/webhook'));
    expect(mocks.verify).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
      authServiceUrl: 'https://configured.test/auth',
    }));
  });

  it.each(['STORE', 'DISCOVERY', 'TRUST'] as const)('returns unavailable for %s without exposing internal details', async (code) => {
    const response = kernelWebhookFailure(new KernelWebhookError(code, 'private internal detail'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook verification unavailable' });
  });

  it('reports a non-JSON authenticated body as 400', () => {
    expect(kernelWebhookFailure(new KernelWebhookError('INVALID_BODY', 'private detail')).status).toBe(400);
  });

  it('does not expose provisioning failure details', async () => {
    const response = kernelWebhookFailure(new Error('private provisioning detail'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
  });
});
