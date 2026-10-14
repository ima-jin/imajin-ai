import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKernelWebhookSigner, registerKernelWebhookSigner } from '@imajin/bus';
import { ensureWebhookSignerRegistered, signRegisteredKernelWebhook } from '../register-webhook-signer';
import { resolveKernelWebhookAudience } from '../kernel-webhook-recipient';

vi.mock('../kernel-webhook-recipient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../kernel-webhook-recipient')>(),
  resolveKernelWebhookAudience: vi.fn(async () => 'did:imajin:events'),
}));

afterEach(() => {
  registerKernelWebhookSigner(null);
  vi.unstubAllEnvs();
});

describe('kernel bus webhook signer registration', () => {
  it('registers the exact shared signer idempotently and replaces stale registrations', () => {
    ensureWebhookSignerRegistered();
    expect(getKernelWebhookSigner()).toBe(signRegisteredKernelWebhook);
    ensureWebhookSignerRegistered();
    expect(getKernelWebhookSigner()).toBe(signRegisteredKernelWebhook);
    registerKernelWebhookSigner(() => ({}));
    ensureWebhookSignerRegistered();
    expect(getKernelWebhookSigner()).toBe(signRegisteredKernelWebhook);
  });

  it('cannot fall back to an ephemeral key when the published signing key is missing', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    ensureWebhookSignerRegistered();
    const url = 'https://events.test/api/webhook/settlement';
    await expect(getKernelWebhookSigner()!(url, '{}', { appSlug: 'events' })).rejects.toThrow('AUTH_PRIVATE_KEY');
    expect(resolveKernelWebhookAudience).toHaveBeenCalledWith(url, { appSlug: 'events' });
  });
});
