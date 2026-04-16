import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { sendEmail, renderBroadcastEmail } from '@imajin/email';
import { withLogger } from '@imajin/logger';
import { requireAdmin } from '@imajin/auth';
import { generateUnsubscribeToken } from '@/src/lib/www/subscribe-tokens';

const sql = getClient();

function buildUnsubscribeUrl(email: string, listSlug: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://jin.imajin.ai';
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

  // Test mode: send to specified email or fall back to operator's profile email
  if (test) {
    let targetEmail = testEmail?.trim() || null;
    if (!targetEmail) {
      const [profile] = await sql`
        SELECT contact_email FROM profile.profiles WHERE did = ${session.actingAs} LIMIT 1
      `;
      targetEmail = (profile?.contact_email as string | null) || null;
    }
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

  let emails: string[] = [];

  let listSlug = 'updates'; // default for connections audience

  if (audienceType === 'newsletter') {
    if (!audienceId) return NextResponse.json({ error: 'audienceId required for newsletter' }, { status: 400 });

    // Look up the list slug for unsubscribe URLs
    const [listRow] = await sql`SELECT slug FROM www.mailing_lists WHERE id = ${audienceId} LIMIT 1`;
    if (listRow?.slug) listSlug = listRow.slug as string;

    const rows = await sql`
      SELECT c.email
      FROM www.contacts c
      JOIN www.subscriptions s ON c.id = s.contact_id
      WHERE s.mailing_list_id = ${audienceId}
        AND s.status = 'subscribed'
        AND c.is_verified = TRUE
    `;
    emails = rows.map((r) => r.email as string);
  } else {
    // connections mode
    const rows = await sql`
      SELECT DISTINCT
        CASE
          WHEN c.did_a = ${session.actingAs} THEN c.did_b
          ELSE c.did_a
        END AS connected_did
      FROM connections.connections c
      WHERE (c.did_a = ${session.actingAs} OR c.did_b = ${session.actingAs})
        AND c.disconnected_at IS NULL
    `;
    const dids = rows.map((r) => r.connected_did as string).filter(Boolean);
    if (dids.length > 0) {
      const profileRows = await sql.unsafe(
        `SELECT contact_email FROM profile.profiles WHERE did = ANY($1) AND contact_email IS NOT NULL`,
        [dids]
      );
      emails = profileRows.map((r) => r.contact_email as string).filter(Boolean);
    }
  }

  if (emails.length === 0) {
    return NextResponse.json({ sent: false, recipientCount: 0, sendId: null, error: 'No recipients found' });
  }

  const sendId = `nws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Record the send before dispatching (non-blocking send)
  await sql`
    INSERT INTO registry.newsletter_sends (id, sender_did, subject, audience_type, audience_id, recipient_count)
    VALUES (${sendId}, ${session.actingAs}, ${subject}, ${audienceType}, ${audienceId ?? null}, ${emails.length})
  `;

  // Fire and forget
  sendBatch({ emails, subject, html, text, replyTo, listSlug }).catch((err) => {
    log.error({ err: String(err) }, 'Newsletter batch send error');
  });

  return NextResponse.json({ sent: true, recipientCount: emails.length, sendId });
});
