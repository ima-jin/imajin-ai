/** Kernel-only boot hook: bus code cannot import the kernel's signing key. */
import { getKernelWebhookSigner, registerKernelWebhookSigner } from '@imajin/bus';
import { signKernelWebhook } from './kernel-webhook';
import { resolveKernelWebhookAudience, type KernelWebhookRecipient } from './kernel-webhook-recipient';

export async function signRegisteredKernelWebhook(
  url: string,
  rawBody: string,
  recipient: KernelWebhookRecipient,
): Promise<Record<string, string>> {
  return signKernelWebhook(url, rawBody, await resolveKernelWebhookAudience(url, recipient));
}

export function ensureWebhookSignerRegistered(): void {
  if (getKernelWebhookSigner() === signRegisteredKernelWebhook) return;
  registerKernelWebhookSigner(signRegisteredKernelWebhook);
}
