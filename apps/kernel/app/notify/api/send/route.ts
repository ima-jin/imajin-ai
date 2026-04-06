import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { nanoid } from 'nanoid';
import { db } from '@/src/db';
import { notifications, preferences } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { getTemplate } from '@/src/lib/notify/templates';
import { sendEmail } from '@imajin/email';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
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
    // We need the recipient's email — for now, use `to` if it looks like an email,
    // otherwise skip (the profile service would need to resolve this)
    const recipientEmail = (data as any).email as string | undefined;
    if (recipientEmail) {
      try {
        await sendEmail({
          to: recipientEmail,
          subject: template.email.subject(data as Record<string, any>),
          html: template.email.html(data as Record<string, any>),
        });
        channelsSent.push('email');
      } catch (err) {
        console.error('Email send failed for notification', id, err);
      }
    }
  }

  // Update channels_sent
  if (channelsSent.length > 0) {
    await db
      .update(notifications)
      .set({ channelsSent })
      .where(eq(notifications.id, id));
  }

  return NextResponse.json({ id, sent: true }, { headers: cors });
}
