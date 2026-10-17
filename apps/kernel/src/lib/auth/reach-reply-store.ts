import { getClient } from '@imajin/db';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import { canonicalReachReply, reachReplyEvent, type SignedReachReplyEvent } from './reach-reply-wire';

export type StoreReachReplyResult =
  | { ok: true; reply: SignedReachReplyEvent; published: boolean }
  | { ok: false; status: 403 | 404 | 409; error: string };

/** Read-time block state is authoritative, never a stale envelope JSON field. */
export async function listReachInbox(params: { principalDid: string }): Promise<Array<ReachEnvelope & { blocked: boolean }>> {
  const rows = await getClient().unsafe<{ envelope: ReachEnvelope; blocked: boolean }[]>(`
    SELECT deliveries.envelope, blocks.requester_did IS NOT NULL AS blocked
    FROM auth.reach_envelopes AS deliveries
    LEFT JOIN auth.reach_sender_blocks AS blocks
      ON blocks.principal_did = deliveries.principal_did
      AND blocks.requester_did = deliveries.requester_did
    WHERE deliveries.principal_did = $1
    ORDER BY deliveries.created_at DESC, deliveries.reach_id DESC
    LIMIT 25
  `, [params.principalDid]);
  return rows.map((row) => ({ ...row.envelope, blocked: row.blocked }));
}

/** Uses the same principal lock as block and delivery, in READ COMMITTED. */
export function persistReachReply(params: {
  principalDid: string;
  reachId: string;
  reply: SignedReachReplyEvent;
}): Promise<StoreReachReplyResult> {
  return getClient().begin('isolation level read committed', async (tx): Promise<StoreReachReplyResult> => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`reach:${params.principalDid}`]);
    const [row] = await tx.unsafe<{ envelope: ReachEnvelope }[]>(
      'SELECT envelope FROM auth.reach_envelopes WHERE principal_did = $1 AND reach_id = $2',
      [params.principalDid, params.reachId],
    );
    if (!row) return { ok: false, status: 404, error: 'Reach envelope not found' };
    const blocked = await tx.unsafe(
      'SELECT 1 FROM auth.reach_sender_blocks WHERE principal_did = $1 AND requester_did = $2',
      [params.principalDid, row.envelope.requesterDid],
    );
    if (blocked.length) return { ok: false, status: 403, error: 'Reach sender is blocked' };
    const { signature, ...unsigned } = params.reply.payload;
    const expected = reachReplyEvent(row.envelope, unsigned.message, unsigned.issuedAt);
    if (canonicalReachReply({ ...params.reply, payload: unsigned }) !== canonicalReachReply(expected)) {
      return { ok: false, status: 403, error: 'Reply does not bind this envelope' };
    }
    if (row.envelope.reply) {
      // JSONB normalizes object key order; compare canonical signed bytes.
      if (canonicalReachReply(row.envelope.reply) !== canonicalReachReply(params.reply)) {
        return { ok: false, status: 409, error: 'Reach envelope already has a reply' };
      }
      return { ok: true, reply: row.envelope.reply, published: Boolean(row.envelope.replyPublishedAt) };
    }
    const reply = { ...expected, payload: { ...expected.payload, signature } };
    await tx.unsafe(`
      UPDATE auth.reach_envelopes SET envelope = jsonb_set(envelope, '{reply}', $3::jsonb)
      WHERE principal_did = $1 AND reach_id = $2
    `, [params.principalDid, params.reachId, JSON.stringify(reply)]);
    return { ok: true, reply, published: false };
  });
}

/** Acknowledgement never changes or re-signs the immutable event. */
export async function markReachReplyPublished(params: { principalDid: string; reachId: string }): Promise<void> {
  await getClient().begin('isolation level read committed', async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`reach:${params.principalDid}`]);
    await tx.unsafe(`
      UPDATE auth.reach_envelopes
      SET envelope = jsonb_set(envelope, '{replyPublishedAt}', to_jsonb(statement_timestamp()::text))
      WHERE principal_did = $1 AND reach_id = $2
        AND envelope ? 'reply' AND NOT (envelope ? 'replyPublishedAt')
    `, [params.principalDid, params.reachId]);
  });
}
