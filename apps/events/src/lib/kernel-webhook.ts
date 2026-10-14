import { NextResponse } from 'next/server';
import { KernelWebhookError, verifyKernelWebhook, type KernelWebhookNonceStore } from '@imajin/auth/kernel-webhook';
import { getEventsAppDid } from './app-identity';

const NONCE_STORE = Symbol.for('@imajin/events:kernel-webhook-nonce-store');
type StoreHolder = { [NONCE_STORE]?: KernelWebhookNonceStore };

/** Configure before serving callbacks on multi-worker hosts; consume must be atomic and durable. */
export function configureEventsWebhookNonceStore(store: KernelWebhookNonceStore): void {
  (globalThis as StoreHolder)[NONCE_STORE] = store;
}

/** SDK default replay protection is process-wide and suitable only for a single worker. */
export async function verifyEventsKernelWebhook<T>(request: Request): Promise<T> {
  const audience = await getEventsAppDid();
  const authServiceUrl = process.env.AUTH_SERVICE_URL || process.env.AUTH_URL
    || (process.env.IMAJIN_KERNEL_URL ? `${process.env.IMAJIN_KERNEL_URL.replace(/\/$/, '')}/auth` : undefined);
  return verifyKernelWebhook<T>(request, {
    audience, authServiceUrl, nonceStore: (globalThis as StoreHolder)[NONCE_STORE],
  });
}

/** Do not expose key discovery, store paths, or internal identity errors to senders. */
export function kernelWebhookFailure(error: unknown): Response {
  if (!(error instanceof KernelWebhookError)) {
    return NextResponse.json({ error: 'Webhook verification unavailable' }, { status: 503 });
  }
  if (['STORE', 'DISCOVERY', 'TRUST'].includes(error.code)) {
    return NextResponse.json({ error: 'Webhook verification unavailable' }, { status: 503 });
  }
  const status = error.code === 'INVALID_BODY' ? 400 : 401;
  return NextResponse.json({ error: 'Invalid kernel webhook', code: error.code }, { status });
}
