/**
 * Connections invite creation for a payment_request's "new counterparty"
 * recipient path (#2206/#2210).
 *
 * Deliberately a separate, minimal code path from `POST
 * /connections/api/invites` (`app/connections/api/invites/route.ts`): that
 * route enforces viral-growth guards (tier-based pending limits, a 7-day
 * cooldown, trust-graph membership) that don't apply here — a business
 * issuing an invoice to a named customer isn't growing the trust graph
 * virally, and gating it on the issuer's own social-invite quota would be
 * an arbitrary, unrelated failure mode for a receivable.
 *
 * Still reuses the load-bearing parts of the same primitive:
 *  - `resolveOrMintInviteTarget` (#1834) for one-DID-per-email dedup — an
 *    email that already belongs to a real identity is never shadowed by a
 *    duplicate stub, and a repeat introduction of the same email silently
 *    accrues to the existing stub (match-without-disclosure).
 *  - The `connections.invites` table + `code`/`toDid` shape the accept
 *    route (`app/connections/api/invites/[code]/accept/route.ts`) already
 *    knows how to resolve — so accepting one of these invites is a normal
 *    accept, no payment_request-specific branch needed there.
 *
 * `reasonContextId`/`reasonContextType` (migration 0144) is the opaque,
 * vertical-agnostic "why this invite exists" pointer #1839 calls for: the
 * invite response never carries anything about the payment_request beyond
 * this reference, and the reference itself resolves to nothing without a
 * separate authenticated/opaque-handle read (see
 * `apps/kernel/app/pay/api/payment-requests/by-handle/[handle]/route.ts`).
 */
import { randomBytes } from 'node:crypto';
import { db, invites } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { publish } from '@imajin/bus';
import { buildPublicUrl } from '@imajin/config';
import { resolveOrMintInviteTarget } from '@/src/lib/auth/claimable-stub';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * Generous relative to the viral-growth invite's 7-day expiry — a
 * payment_request can legitimately sit unpaid/unclaimed for a while (its
 * own `due_at` is the more meaningful deadline), and expiring the invite
 * out from under a still-open receivable would strand the pay-first
 * ordering's later claim step.
 */
const PAYMENT_REQUEST_INVITE_EXPIRY_DAYS = 30;

export interface CreatePaymentRequestInviteInput {
  issuerDid: string;
  email: string;
  delivery: 'link' | 'email';
  note?: string | null;
  reasonContextId: string;
  reasonContextType: string;
}

export interface CreatedPaymentRequestInvite {
  /** The claimable-stub (or existing real identity) DID this invite targets — stored as the payment_request's `recipient_stub_id`. */
  recipientStubId: string;
  inviteId: string;
  inviteCode: string;
  inviteUrl: string;
}

/**
 * Create (never reuse) an invite carrying `reasonContextId`/`reasonContextType`
 * as its opaque reason. The underlying claimable-stub target IS
 * created-or-reused per email (#1834) — only the invite row itself is
 * always fresh, one per payment_request.
 */
export async function createPaymentRequestInvite(
  input: CreatePaymentRequestInviteInput,
): Promise<CreatedPaymentRequestInvite> {
  const recipientStubId = await resolveOrMintInviteTarget(input.email);

  const code = randomBytes(12).toString('hex');
  const id = generateId('inv');
  const expiresAt = new Date(Date.now() + PAYMENT_REQUEST_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const [invite] = await db
    .insert(invites)
    .values({
      id,
      code,
      fromDid: input.issuerDid,
      toEmail: input.email.toLowerCase().trim(),
      toDid: recipientStubId,
      note: input.note || null,
      delivery: input.delivery,
      status: 'pending',
      maxUses: 1,
      expiresAt: expiresAt.toISOString(),
      reasonContextId: input.reasonContextId,
      reasonContextType: input.reasonContextType,
    })
    .returning();

  const inviteUrl = `${buildPublicUrl('connections')}/invite/${input.issuerDid}/${code}`;

  // subject = recipientStubId (#1846 convention): the invitee's DID, not
  // the issuer's, so any attestation reactor lands on them.
  publish('connection.invited', {
    issuer: input.issuerDid,
    subject: recipientStubId,
    scope: 'connections',
    payload: { context_id: invite.id, context_type: 'connection', delivery: invite.delivery },
  }).catch((err: unknown) => {
    log.error({ err: String(err) }, '[payment_request] connection.invited publish error');
  });

  return { recipientStubId, inviteId: invite.id, inviteCode: invite.code, inviteUrl };
}
