/** Kernel-only boot hook: bus code cannot import the kernel's signing key. */
import { getKernelWebhookSigner, registerKernelWebhookSigner } from '@imajin/bus';
import { signKernelWebhook } from './kernel-webhook';

export function ensureWebhookSignerRegistered(): void {
  if (getKernelWebhookSigner() === signKernelWebhook) return;
  registerKernelWebhookSigner(signKernelWebhook);
}
