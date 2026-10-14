import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKernelWebhookSigner, registerKernelWebhookSigner } from '@imajin/bus';
import { signKernelWebhook } from '../kernel-webhook';
import { ensureWebhookSignerRegistered } from '../register-webhook-signer';

afterEach(() => {
  registerKernelWebhookSigner(null);
  vi.unstubAllEnvs();
});

describe('kernel bus webhook signer registration', () => {
  it('registers the exact shared signer idempotently and replaces stale registrations', () => {
    ensureWebhookSignerRegistered();
    expect(getKernelWebhookSigner()).toBe(signKernelWebhook);
    ensureWebhookSignerRegistered();
    expect(getKernelWebhookSigner()).toBe(signKernelWebhook);
    registerKernelWebhookSigner(() => ({}));
    ensureWebhookSignerRegistered();
    expect(getKernelWebhookSigner()).toBe(signKernelWebhook);
  });

  it('cannot fall back to an ephemeral key when the published signing key is missing', () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    ensureWebhookSignerRegistered();
    expect(() => getKernelWebhookSigner()!('https://events.test/api/webhook/settlement', '{}')).toThrow('AUTH_PRIVATE_KEY');
  });
});
