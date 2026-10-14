import { loadAppSigningKey, type AppSigningKey } from '@imajin/auth-client';

const IDENTITY_KEY = Symbol.for('@imajin/events:app-signing-identity');
type IdentityHolder = { [IDENTITY_KEY]?: Promise<AppSigningKey> };

/** Shared across Next route bundles: a one-time claim must never be redeemed twice. */
export function getEventsSigningIdentity(): Promise<AppSigningKey> {
  const holder = globalThis as IdentityHolder;
  if (holder[IDENTITY_KEY]) return holder[IDENTITY_KEY];
  const kernelUrl = process.env.IMAJIN_KERNEL_URL;
  if (!kernelUrl) return Promise.reject(new Error('events app identity: IMAJIN_KERNEL_URL is not set'));
  const pending = loadAppSigningKey({ kernelUrl, hostHint: 'events' }).catch((error: unknown) => {
    delete holder[IDENTITY_KEY];
    throw error;
  });
  holder[IDENTITY_KEY] = pending;
  return pending;
}

/** Expected recipient is local configuration/identity, never an inbound header. */
export async function getEventsAppDid(): Promise<string> {
  return process.env.IMAJIN_APP_DID || (await getEventsSigningIdentity()).appDid;
}

export function resetEventsIdentityForTests(): void {
  delete (globalThis as IdentityHolder)[IDENTITY_KEY];
}
