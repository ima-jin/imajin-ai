import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { nanoid } from 'nanoid';
import { withLogger } from '@imajin/logger';
import { db, notifications, preferences, identities, profiles } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { getTemplate } from '@/src/lib/notify/templates';
import { sendEmail } from '@imajin/email';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * Resolve the email address for a notification recipient.
 * Checks the request payload, then the profile table, then the identity table.
 *
 * Cognitive complexity: 3 (≤ 15)
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
  return identity?.contactEmail ?? undefined;
}

/**
 * Resolve recipient email and send the email notification.
 * Returns true if the email was sent successfully.
 *
 * Cognitive complexity: 2 (≤ 15)
 */
async function resolveAndSendEmail(
  to: string,
  data: Record<string, unknown>,
  template: import('@/src/lib/notify/templates').NotifyTemplate,
  log: { error: (obj: Record<string, unknown>, msg: string) => void },
  notifId: string,
): Promise<boolean> {
  const recipientEmail = await resolveRecipientEmail(to, data);
  if (!recipientEmail) return false;
  try {
    await sendEmail({
      to: recipientEmail,
      subject: template.email!.subject(data as Record<string, any>),
      html: template.email!.html(data as Record<string, any>),
    });
    return true;
  } catch (err) {
    log.error({ err: String(err), id: notifId }, 'Email send failed for notification');
    return false;
  }
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

  // Store notification
  const id = `ntf_${nanoid(16)}`;
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
  });

  const channelsSent: string[] = [];

  if (inappEnabled) {
    channelsSent.push('inapp');
  }

  // Send email if enabled and template has email config
  if (emailEnabled && template?.email) {
    const emailSent = await resolveAndSendEmail(to, data, template, log, id);
    if (emailSent) channelsSent.push('email');
  }

  // Update channels_sent
  if (channelsSent.length > 0) {
    await db
      .update(notifications)
      .set({ channelsSent })
      .where(eq(notifications.id, id));
  }

  return NextResponse.json({ id, sent: true }, { headers: cors });
});
