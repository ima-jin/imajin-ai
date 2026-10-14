import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authenticatePayApp as authenticateRegisteredApp } from '../pay/app-service-auth';
import { requireInternalApiKey, ATTESTATION_INTERNAL_API_KEY_PURPOSE } from '../auth/require-internal-api-key';
import { getInternalSecret } from '../vault/internal-secret';

export type NotifyServiceScope = 'notify:send' | 'notify:broadcast' | 'notify:interest';

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
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  if (!await requireInternalApiKey(request)) return null;
  const result = await authenticateRegisteredApp(request, scope);
  return 'error' in result
    ? NextResponse.json({ error: result.error }, { status: result.status, headers })
    : null;
}

/** Never forward a caller's app token to a privileged registry endpoint. */
export async function notifyRegistryKey(): Promise<string> {
  return getInternalSecret(ATTESTATION_INTERNAL_API_KEY_PURPOSE);
}
