import type { getClient } from '@imajin/db';

type SqlClient = ReturnType<typeof getClient>;

export type NewsletterAudienceType = 'newsletter' | 'connections';

export type AudienceResult =
  | { ok: true; emails: string[]; listSlug: string }
  | { ok: false; error: string; status: number };

/**
 * Resolve the send-time test recipient: the explicit `testEmail`, or the
 * operator's own profile contact email as a fallback.
 */
export async function resolveTestRecipient(
  sql: SqlClient,
  testEmail: string | undefined,
  operatorDid: string,
): Promise<string | null> {
  const explicit = testEmail?.trim() || null;
  if (explicit) return explicit;

  const [profile] = await sql`
    SELECT contact_email FROM profile.profiles WHERE did = ${operatorDid} LIMIT 1
  `;
  return (profile?.contact_email as string | null) || null;
}

/** Resolve the recipient list + unsubscribe list slug for a newsletter-list audience. */
async function resolveNewsletterListAudience(sql: SqlClient, audienceId: string): Promise<AudienceResult> {
  const [listRow] = await sql`SELECT slug FROM www.mailing_lists WHERE id = ${audienceId} LIMIT 1`;
  const listSlug = (listRow?.slug as string) || 'updates';

  const rows = await sql`
    SELECT c.email
    FROM www.contacts c
    JOIN www.subscriptions s ON c.id = s.contact_id
    WHERE s.mailing_list_id = ${audienceId}
      AND s.status = 'subscribed'
      AND c.is_verified = TRUE
  `;
  return { ok: true, emails: rows.map((r) => r.email as string), listSlug };
}

/** Resolve the recipient list for a connections-based audience (the sender's active connections). */
async function resolveConnectionsAudience(sql: SqlClient, actingDid: string): Promise<AudienceResult> {
  const rows = await sql`
    SELECT DISTINCT
      CASE
        WHEN c.did_a = ${actingDid} THEN c.did_b
        ELSE c.did_a
      END AS connected_did
    FROM connections.connections c
    WHERE (c.did_a = ${actingDid} OR c.did_b = ${actingDid})
      AND c.disconnected_at IS NULL
  `;
  const dids = rows.map((r) => r.connected_did as string).filter(Boolean);
  if (dids.length === 0) {
    return { ok: true, emails: [], listSlug: 'updates' };
  }

  const profileRows = await sql.unsafe(
    `SELECT contact_email FROM profile.profiles WHERE did = ANY($1) AND contact_email IS NOT NULL`,
    [dids],
  );
  return { ok: true, emails: profileRows.map((r) => r.contact_email as string).filter(Boolean), listSlug: 'updates' };
}

/** Resolve the newsletter send audience (recipient emails + unsubscribe list slug) for either audience type. */
export async function resolveNewsletterAudience(
  sql: SqlClient,
  params: { audienceType: NewsletterAudienceType; audienceId?: string; actingDid: string },
): Promise<AudienceResult> {
  const { audienceType, audienceId, actingDid } = params;

  if (audienceType === 'newsletter') {
    if (!audienceId) return { ok: false, error: 'audienceId required for newsletter', status: 400 };
    return resolveNewsletterListAudience(sql, audienceId);
  }

  return resolveConnectionsAudience(sql, actingDid);
}
