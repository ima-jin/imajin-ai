import { NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { sendEmail, renderBroadcastEmail } from '@imajin/email';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';
import { generateUnsubscribeToken } from '@/src/lib/www/subscribe-tokens';
import { randomUUID } from 'node:crypto';
import { buildPublicUrlAbsolute } from '@imajin/config';
import { resolveNewsletterAudience, resolveTestRecipient } from '@/src/lib/admin/newsletter-send';

const sql = getClient();

function buildUnsubscribeUrl(email: string, listSlug: string): string {
  const baseUrl = buildPublicUrlAbsolute('kernel');
  const token = generateUnsubscribeToken(email, listSlug);
  return `${baseUrl}/api/subscribe/unsubscribe?email=${encodeURIComponent(email)}&list=${encodeURIComponent(listSlug)}&token=${token}`;
}

interface SendBatchOptions {
  emails: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  listSlug?: string;
}

async function sendBatch({ emails, subject, html, text, replyTo, listSlug }: SendBatchOptions) {
  const BATCH_SIZE = 10;
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((to) => sendEmail({
        to,
        subject,
        html,
        text,
        replyTo,
        unsubscribeUrl: listSlug ? buildUnsubscribeUrl(to, listSlug) : undefined,
      }))
    );
    if (i + BATCH_SIZE < emails.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export const POST = withLogger('kernel', async (req, { log }) => {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    subject: string;
    markdown: string;
    audienceType: 'newsletter' | 'connections';
    audienceId?: string;
    test?: boolean;
    testEmail?: string;
    replyTo?: string;
  };

  const { subject, markdown, audienceType, audienceId, test, testEmail, replyTo } = body;
  if (!subject || !markdown || !audienceType) {
    return NextResponse.json({ error: 'subject, markdown, and audienceType are required' }, { status: 400 });
  }

  const { html, text } = renderBroadcastEmail(markdown);
  const actingDid = session.actingAs ?? '';

  // Test mode: send to specified email or fall back to operator's profile email
  if (test) {
    const targetEmail = await resolveTestRecipient(sql, testEmail, actingDid);
    if (!targetEmail) {
      return NextResponse.json({ error: 'No test email provided and no contact email on operator profile' }, { status: 400 });
    }
    await sendEmail({
      to: targetEmail,
      subject: `[TEST] ${subject}`,
      html,
      text,
      replyTo,
      unsubscribeUrl: buildUnsubscribeUrl(targetEmail, 'updates'),
    });
    return NextResponse.json({ sent: true, recipientCount: 1, sendId: null });
  }

  const audience = await resolveNewsletterAudience(sql, { audienceType, audienceId, actingDid });
  if (!audience.ok) {
    return NextResponse.json({ error: audience.error }, { status: audience.status });
  }
  const { emails, listSlug } = audience;

  if (emails.length === 0) {
    return NextResponse.json({ sent: false, recipientCount: 0, sendId: null, error: 'No recipients found' });
  }

  const sendId = `nws_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;

  // Record the send before dispatching (non-blocking send)
  await sql`
    INSERT INTO registry.newsletter_sends (id, sender_did, subject, audience_type, audience_id, recipient_count)
    VALUES (${sendId}, ${actingDid}, ${subject}, ${audienceType}, ${audienceId ?? null}, ${emails.length})
  `;

  // Fire and forget
  sendBatch({ emails, subject, html, text, replyTo, listSlug }).catch((err) => {
    log.error({ err: String(err) }, 'Newsletter batch send error');
  });

  return NextResponse.json({ sent: true, recipientCount: emails.length, sendId });
});
