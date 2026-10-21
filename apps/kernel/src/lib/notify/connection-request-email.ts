import { getClient } from '@imajin/db';
import type { MailDeliverySafety } from '@/src/lib/kernel/mail-delivery-error';

export const CONNECTION_REQUEST_SCOPE = 'connection:request-received';

/** This scope never accepts an address supplied by the sender, including in stored/WS data. */
export function sanitizeConnectionRequestData(scope: string, data: Record<string, unknown>): Record<string, unknown> {
  if (scope !== CONNECTION_REQUEST_SCOPE) return data;
  const safeData = { ...data };
  delete safeData.email;
  return safeData;
}

/**
 * Serialize the pair's check/send/success record across workers. The notification
 * already exists (and its in-app channels are saved) before entering this helper.
 * Only successful provider handoffs consume the rolling 24-hour allowance.
 */
interface ConnectionRequestEmailResult extends MailDeliverySafety {
  delivered: boolean;
  emailResolved: boolean;
  error?: string;
}

export async function deliverConnectionRequestEmail(params: {
  recipientDid: string;
  fromDid: unknown;
  notificationId: string;
  deliver: (email: string) => Promise<ConnectionRequestEmailResult>;
}): Promise<ConnectionRequestEmailResult | null> {
  const { fromDid } = params;
  if (!params.recipientDid.startsWith('did:') || typeof fromDid !== 'string' || !fromDid.startsWith('did:')) return null;
  return await getClient().begin('isolation level read committed', async (tx): Promise<ConnectionRequestEmailResult | null> => {
    // JSON encoding keeps distinct pairs distinct even if a DID contains separators.
    const pairKey = JSON.stringify([CONNECTION_REQUEST_SCOPE, params.recipientDid, fromDid]);
    await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [pairKey]);
    const [credential] = await tx.unsafe<{ value: string }[]>(`
      SELECT value FROM auth.credentials
      WHERE did = $1 AND type = 'email' AND verified_at IS NOT NULL
      ORDER BY verified_at DESC, id
      LIMIT 1
    `, [params.recipientDid]);
    if (!credential?.value) return null;
    const prior = await tx.unsafe(`
      SELECT 1 FROM notify.notifications
      WHERE recipient_did = $1 AND scope = $2 AND data->>'fromDid' = $3
        AND channels_sent @> ARRAY['email']::text[]
        AND created_at > clock_timestamp() - interval '24 hours'
      LIMIT 1
    `, [params.recipientDid, CONNECTION_REQUEST_SCOPE, fromDid]);
    if (prior.length) return null;
    const result = await params.deliver(credential.value);
    if (result.delivered) {
      await tx.unsafe(`
        UPDATE notify.notifications
        SET channels_sent = array_append(COALESCE(channels_sent, ARRAY[]::text[]), 'email')
        WHERE id = $1
      `, [params.notificationId]);
    }
    return result;
  });
}
