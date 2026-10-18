import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authenticatePayApp as authenticateRegisteredApp } from '../pay/app-service-auth';
import { requireInternalApiKey, ATTESTATION_INTERNAL_API_KEY_PURPOSE } from '../auth/require-internal-api-key';
import { getInternalSecret } from '../vault/internal-secret';
import { acceptsLegacyNotifyCredential } from './legacy-auth';
import { db, registryApps } from '@/src/db';
import { and, eq } from 'drizzle-orm';

export type NotifyServiceScope = 'notify:send' | 'notify:broadcast' | 'notify:interest';

export interface NotifySender {
  ownerDid?: string;
  appDid?: string;
}

type NotifyAuthentication = { response: NextResponse; sender?: never; internal?: never }
  | { response: null; sender: NotifySender; internal: boolean };

/**
 * Internal callers retain the vault-only Bearer contract. External callers
 * must carry an app-service JWT and current operator approval, never a session
 * or user-delegated app token. Re-read the registration on every request.
 */
export async function requireNotifyAuth(
  request: NextRequest,
  scope: NotifyServiceScope,
  headers: Record<string, string>,
): Promise<NextResponse | null> {
  const result = await authenticateNotifyCaller(request, scope, headers);
  return result.response;
}

async function authenticateNotifyCaller(
  request: NextRequest,
  scope: NotifyServiceScope,
  headers: Record<string, string>,
): Promise<NotifyAuthentication> {
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) {
    if (acceptsLegacyNotifyCredential(request)) return { response: null, sender: {}, internal: false };
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers }) };
  }
  if (!await requireInternalApiKey(request)) return { response: null, sender: {}, internal: true };
  const result = await authenticateRegisteredApp(request, scope);
  return 'error' in result
    ? { response: NextResponse.json({ error: result.error }, { status: result.status, headers }) }
    : { response: null, sender: { appDid: result.appDid }, internal: false };
}

/** Sender authority comes only from the authenticated app's live registration. */
export async function authenticateNotifySender(
  request: NextRequest,
  scope: NotifyServiceScope,
  headers: Record<string, string>,
): Promise<NotifyAuthentication> {
  const result = await authenticateNotifyCaller(request, scope, headers);
  if (result.response || !result.sender.appDid) return result;
  const [app] = await db.select({ ownerDid: registryApps.ownerDid })
    .from(registryApps)
    .where(and(eq(registryApps.appDid, result.sender.appDid), eq(registryApps.status, 'active')))
    .limit(1);
  if (!app?.ownerDid) {
    return { response: NextResponse.json({ error: 'Forbidden - app has no active registered owner' }, { status: 403, headers }) };
  }
  return { response: null, sender: { appDid: result.sender.appDid, ownerDid: app.ownerDid }, internal: false };
}

/** Never forward a caller's app token to a privileged registry endpoint. */
export async function notifyRegistryKey(): Promise<string> {
  return getInternalSecret(ATTESTATION_INTERNAL_API_KEY_PURPOSE);
}
