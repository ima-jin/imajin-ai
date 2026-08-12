import { send } from '@imajin/notify';
import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:attestation-notify');

/**
 * Notify the subject of an attestation that is genuinely awaiting their
 * counter-signature (#1820 — counterparty pending-signature notifications).
 *
 * `attestation.created` fires for every attestation the platform writes,
 * including the many one-shot system attestations (identity.created,
 * connection.accepted, vouch, ticket.purchased, etc.) that flow through the
 * internal service-to-service route via `emitAttestation()`. Those never carry
 * an `author_jws` and are not awaiting anyone's signature, so this reactor
 * gates on `payload.pendingSignature` to only notify for the bilateral
 * attestations created via the public `/api/attestations` route with an
 * `author_jws` — the actual "pending signature" case.
 *
 * Two additional skips keep this from notifying nobody:
 * - Self-attestations (`issuer === subject`) — there is no counterparty to tell.
 * - Subjects that resolve to an unclaimed profile stub — a stub has no email on
 *   file, so `notify/api/send` would write an in-app row nobody can ever read.
 *   The connection-invite email already covers bringing a stub online.
 */
export const attestationNotifyReactor: ReactorHandler = async (event) => {
  if (!event.subject || event.issuer === event.subject) return;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (payload.pendingSignature !== true) return;

  if (await isUnclaimedStub(event.subject)) return;

  const attestationId = typeof payload.attestationId === 'string' ? payload.attestationId : undefined;
  const type = typeof payload.type === 'string' ? payload.type : event.type;
  const originUrl = typeof payload.originUrl === 'string' ? payload.originUrl : undefined;

  await send({
    to: event.subject,
    scope: 'attest.pending_signature',
    data: { attestationId, type, originUrl },
  });
};

/**
 * Resolve whether `did` is an unclaimed profile stub (no owner, no email on
 * file) — created via the "maintained places" stub flow. Raw SQL via
 * `@imajin/db`: `packages/bus` cannot import the kernel's Drizzle schema (see
 * `packages/bus/AGENTS.md`). Fails open (`false`) on a DB error so a lookup
 * hiccup degrades to "attempt the notification" rather than silently dropping
 * a genuine counterparty notification.
 */
async function isUnclaimedStub(did: string): Promise<boolean> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const rows = await sql`
      SELECT claim_status, contact_email
      FROM profile.profiles
      WHERE did = ${did}
      LIMIT 1
    `;
    if (rows.length === 0) return false;
    const row = rows[0] as { claim_status: string | null; contact_email: string | null };
    return row.claim_status === 'unclaimed' && !row.contact_email;
  } catch (err) {
    log.warn({ err: String(err), did }, 'isUnclaimedStub lookup failed; proceeding with notify');
    return false;
  }
}
