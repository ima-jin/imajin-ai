import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:webhook');
export interface KernelWebhookRecipient {
  appDid?: string;
  appSlug?: string;
}
export type KernelWebhookSigner = (url: string, rawBody: string, recipient: KernelWebhookRecipient) =>
  Record<string, string> | Promise<Record<string, string>>;

// Instrumentation and routes can use separate Next chunks. Share registration
// across module copies without importing the kernel across the package boundary.
const SIGNER_KEY = Symbol.for('@imajin/bus:kernel-webhook-signer');
type SignerHolder = { [SIGNER_KEY]?: KernelWebhookSigner | null };

export function registerKernelWebhookSigner(signer: KernelWebhookSigner | null): void {
  (globalThis as SignerHolder)[SIGNER_KEY] = signer;
}

export function getKernelWebhookSigner(): KernelWebhookSigner | undefined {
  return (globalThis as SignerHolder)[SIGNER_KEY] ?? undefined;
}

export const webhookReactor: ReactorHandler = async (event, config) => {
  const url = config.url as string;
  if (!url) {
    log.warn({ event: event.type }, 'Webhook reactor: no URL configured');
    return;
  }

  const signer = getKernelWebhookSigner();
  if (!signer) throw new Error('Kernel webhook signer is not registered');

  const body = JSON.stringify({
    type: event.type,
    issuer: event.issuer,
    subject: event.subject,
    scope: event.scope,
    payload: event.payload,
    timestamp: event.timestamp,
    correlationId: event.correlationId,
  });
  const recipient = config.recipient as KernelWebhookRecipient | undefined;
  if (!recipient || (!recipient.appDid && !recipient.appSlug)) {
    throw new Error('Kernel webhook recipient is required');
  }
  const signatures = await signer(url, body, recipient);
  for (const header of ['x-kernel-kid', 'x-kernel-timestamp', 'x-kernel-nonce', 'x-kernel-signature', 'x-kernel-audience']) {
    if (!signatures[header]) throw new Error(`Kernel webhook signer omitted ${header}`);
  }

  // Ignore any legacy config.secret, including old DB-backed reactor configs.
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signatures },
    body,
    redirect: 'error',
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    log.error({ url, status: response.status, text, event: event.type }, 'Webhook delivery failed');
  }
};
