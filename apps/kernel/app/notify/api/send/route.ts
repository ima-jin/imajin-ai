import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { nanoid } from 'nanoid';
import { withLogger } from '@imajin/logger';
import { db, notifications, preferences, identities, profiles, credentials } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { getTemplate } from '@/src/lib/notify/templates';
import { buildNotificationFrame, pushNotificationToDid } from '@/src/lib/notify/ws-push';
import { sendEmail } from '@imajin/email';
import {
  OPERATOR_APPROVAL_REQUESTED_SCOPE,
  getOperatorDid,
  validateApprovalRequestedPayload,
} from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * Resolve the email address for a notification recipient.
 * Checks the request payload, then the profile table, then the identity
 * table, then `auth.credentials` (#1854) — the table the claimable-stub and
 * invite-create paths (#1834/#1849) treat as the source of truth, and which
 * now has normalized rows for every onboarded identity (#1861). A recipient
 * whose only email record lives there — e.g. someone who claimed their
 * identity via an invite rather than Stripe/onboard — was previously
 * invisible to this resolver even though invite-create already trusted it.
 *
 * Cognitive complexity: 4 (≤ 15)
 */
async function resolveRecipientEmail(
  to: string,
  data: Record<string, unknown>,
): Promise<string | undefined> {
  const payloadEmail = (data as Record<string, unknown>).email as string | undefined;
  if (payloadEmail) return payloadEmail;
  if (!to.startsWith('did:')) return undefined;

  const [profile] = await db
    .select({ contactEmail: profiles.contactEmail })
    .from(profiles)
    .where(eq(profiles.did, to))
    .limit(1);
  if (profile?.contactEmail) return profile.contactEmail;

  const [identity] = await db
    .select({ contactEmail: identities.contactEmail })
    .from(identities)
    .where(eq(identities.id, to))
    .limit(1);
  if (identity?.contactEmail) return identity.contactEmail;

  const [credential] = await db
    .select({ value: credentials.value })
    .from(credentials)
    .where(and(eq(credentials.type, 'email'), eq(credentials.did, to)))
    .limit(1);
  return credential?.value ?? undefined;
}

/**
 * Outcome of attempting to resolve + deliver the email leg of a
 * notification (#1854). Kept distinct from the boolean `sent` the response
 * uses so a caller can tell "we never even found an address" apart from
 * "we found one but the provider rejected it" — both used to collapse into
 * the same unconditional `sent: true`.
 */
interface EmailDeliveryResult {
  /** True once the email was actually handed off to the provider successfully. */
  delivered: boolean;
  /** True when a recipient email address could be resolved at all. */
  emailResolved: boolean;
  /** Safe, caller-facing reason when `delivered` is false. */
  error?: string;
}

/**
 * Resolve recipient email and send the email notification, reporting the
 * real outcome (#1854) rather than a bare boolean — Postal (and other
 * providers) return `{ success: false }` rather than throwing on most
 * failures, mirroring the `deliverInviteEmail` fix from #1847.
 *
 * Cognitive complexity: 4 (≤ 15)
 */
async function resolveAndSendEmail(
  to: string,
  data: Record<string, unknown>,
  template: import('@/src/lib/notify/templates').NotifyTemplate,
  log: { error: (obj: Record<string, unknown>, msg: string) => void },
  notifId: string,
): Promise<EmailDeliveryResult> {
  const recipientEmail = await resolveRecipientEmail(to, data);
  if (!recipientEmail) {
    return { delivered: false, emailResolved: false, error: 'No email address found for recipient' };
  }
  try {
    const result = await sendEmail({
      to: recipientEmail,
      subject: template.email!.subject(data as Record<string, any>),
      html: template.email!.html(data as Record<string, any>),
    });
    if (!result.success) {
      log.error({ err: result.error, id: notifId }, 'Email send failed for notification');
      return { delivered: false, emailResolved: true, error: 'Email delivery failed' };
    }
    return { delivered: true, emailResolved: true };
  } catch (err) {
    log.error({ err: String(err), id: notifId }, 'Email send failed for notification');
    return { delivered: false, emailResolved: true, error: 'Email delivery failed' };
  }
}

/**
 * Guard for the `operator.approval.requested` scope (#2059): validates the
 * payload and confirms the recipient is the configured operator DID.
 * Returns the 400 response to return immediately, or null when the request
 * may proceed. Extracted out of POST so its cognitive complexity stays
 * under the SonarCloud threshold (S3776) — no behavior change.
 */
async function rejectInvalidOperatorApprovalRequest(
  scope: string,
  data: Record<string, unknown>,
  to: string,
  cors: Record<string, string>,
): Promise<NextResponse | null> {
  if (scope !== OPERATOR_APPROVAL_REQUESTED_SCOPE) return null;

  const validation = validateApprovalRequestedPayload(data);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }

  const operatorDid = await getOperatorDid();
  if (!operatorDid || to !== operatorDid) {
    return NextResponse.json(
      { error: 'operator.approval.requested must be addressed to the configured operator DID' },
      { status: 400, headers: cors },
    );
  }

  return null;
}

/**
 * Build the /notify/api/send response body (#1854): honest about whether
 * the email leg actually delivered, kept out of POST's own control flow so
 * the handler's complexity stays where it was before this fix.
 */
function buildResponseBody(
  id: string,
  emailResult: EmailDeliveryResult | null,
): { id: string; sent: boolean; emailResolved?: boolean; error?: string } {
  if (!emailResult) return { id, sent: true };
  const body: { id: string; sent: boolean; emailResolved?: boolean; error?: string } = {
    id,
    sent: emailResult.delivered,
    emailResolved: emailResult.emailResolved,
  };
  if (emailResult.error) body.error = emailResult.error;
  return body;
}

export const POST = withLogger('kernel', async (request, { log }) => {
  const cors = corsHeaders(request);

  // Verify webhook secret
  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  let body: {
    to: string;
    scope: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    urgency?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { to, scope, data = {} } = body;
  if (!to || !scope) {
    return NextResponse.json({ error: 'Missing required fields: to, scope' }, { status: 400, headers: cors });
  }

  // #2059 — operator.approval.requested carries a proposal that must never
  // include secret values, and must be addressed to the configured operator
  // DID (never an arbitrary recipient) so the /jin confirm card can only
  // ever reach the one identity allowed to decide it.
  const operatorApprovalRejection = await rejectInvalidOperatorApprovalRequest(scope, data, to, cors);
  if (operatorApprovalRejection) return operatorApprovalRejection;

  // Resolve template
  const template = getTemplate(scope);
  const urgency = body.urgency ?? template?.urgency ?? 'normal';
  const title = body.title ?? (template ? template.title(data as Record<string, any>) : scope);
  const notifBody = body.body ?? (template ? template.body(data as Record<string, any>) : undefined);

  // Look up preferences (default: email + inapp both on)
  const [pref] = await db
    .select()
    .from(preferences)
    .where(and(eq(preferences.did, to), eq(preferences.scope, scope)))
    .limit(1);

  const emailEnabled = pref ? pref.email : true;
  const inappEnabled = pref ? pref.inapp : true;

  // Store notification. `createdAt` is set explicitly rather than left to the
  // column default so the WS frame below carries the same timestamp the row does
  // — a client that receives the push and later reads the row must not see two
  // different creation times for one notification.
  const id = `ntf_${nanoid(16)}`;
  const createdAt = new Date();
  await db.insert(notifications).values({
    id,
    recipientDid: to,
    scope,
    urgency,
    title,
    body: notifBody ?? null,
    data: data as any,
    channelsSent: [],
    read: false,
    createdAt,
  });

  const channelsSent: string[] = [];

  if (inappEnabled) {
    channelsSent.push('inapp');

    // Real-time push down any socket the recipient has open (#1644). Gated on the
    // in-app preference because a WS frame *is* in-app delivery, and awaited only
    // so `channelsSent` can record whether anyone was actually listening — the
    // push itself never fails the request.
    const delivered = await pushNotificationToDid(
      to,
      buildNotificationFrame({ id, scope, title, body: notifBody, data, createdAt }),
    );
    if (delivered) channelsSent.push('ws');
  }

  // Send email if enabled and template has email config (#1854: the result
  // is a structured outcome, not a boolean, so the response below can be
  // honest about whether the email leg actually delivered).
  let emailResult: EmailDeliveryResult | null = null;
  if (emailEnabled && template?.email) {
    emailResult = await resolveAndSendEmail(to, data, template, log, id);
    if (emailResult.delivered) channelsSent.push('email');
  }

  // Update channels_sent
  if (channelsSent.length > 0) {
    await db
      .update(notifications)
      .set({ channelsSent })
      .where(eq(notifications.id, id));
  }

  // #2059 — persist the proposal lifecycle row alongside the notification.
  // Validated above, so `data` is known-shaped here.
  if (scope === OPERATOR_APPROVAL_REQUESTED_SCOPE) {
    await recordApprovalRequested({
      proposalId: data.proposalId as string,
      operatorDid: to,
      kind: data.kind as 'restart' | 'config-mutation' | 'other',
      summary: data.summary as string,
      keysTouched: (data.keysTouched as string[] | undefined) ?? [],
      notificationId: id,
    });
  }

  // #1854: `sent` used to be hardcoded `true` regardless of delivery outcome.
  // When email was actually attempted, the response now reflects whether it
  // was delivered; when it wasn't attempted (no email channel requested, or
  // the recipient has it disabled), the notification itself still succeeded
  // via its other channels, so `sent` stays true — there was nothing to fail.
  return NextResponse.json(buildResponseBody(id, emailResult), { headers: cors });
});
