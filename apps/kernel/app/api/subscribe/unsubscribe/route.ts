import { NextRequest, NextResponse } from 'next/server';
import { db, contacts, subscriptions, mailingLists } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { verifyUnsubscribeToken } from '@/src/lib/www/subscribe-tokens';

function htmlPage(title: string, heading: string, body: string, success: boolean): string {
  const color = success ? '#f59e0b' : '#ef4444';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Imajin</title>
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;">
  <div style="max-width:480px;width:100%;margin:0 auto;padding:32px 16px;text-align:center;">
    <p style="margin:0 0 24px;font-size:15px;font-weight:600;color:#ffffff;letter-spacing:2px;">IMAJIN</p>
    <div style="background-color:#111111;border-radius:12px;padding:40px 32px;border:1px solid #1f1f1f;">
      <p style="margin:0 0 12px;font-size:40px;">${success ? '✓' : '✕'}</p>
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:${color};letter-spacing:-0.3px;">${heading}</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">${body}</p>
      <a href="https://imajin.ai" style="display:inline-block;background-color:#262626;color:#ffffff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Go to Imajin →</a>
    </div>
    <p style="margin:24px 0 0;font-size:12px;color:#3f3f46;">The internet that pays you back</p>
  </div>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  const token = searchParams.get('token');
  const list = searchParams.get('list') || 'updates';

  if (!email || !token) {
    return new NextResponse(
      htmlPage('Invalid link', 'Invalid link', 'This unsubscribe link is missing required parameters.', false),
      { status: 400, headers: { 'Content-Type': 'text/html' } }
    );
  }

  if (!verifyUnsubscribeToken(email, list, token)) {
    return new NextResponse(
      htmlPage('Invalid link', 'Invalid link', 'This unsubscribe link is invalid or has been tampered with.', false),
      { status: 400, headers: { 'Content-Type': 'text/html' } }
    );
  }

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.email, email.toLowerCase().trim()),
  });

  if (!contact) {
    // Return success anyway to avoid email enumeration
    return new NextResponse(
      htmlPage("You've been unsubscribed", "You've been unsubscribed", "You won't receive any more emails from us.", true),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  }

  const mailingList = await db.query.mailingLists.findFirst({
    where: eq(mailingLists.slug, list),
  });

  if (mailingList) {
    const sub = await db.query.subscriptions.findFirst({
      where: and(
        eq(subscriptions.contactId, contact.id),
        eq(subscriptions.mailingListId, mailingList.id)
      ),
    });

    if (sub && sub.status !== 'unsubscribed') {
      await db.update(subscriptions)
        .set({ status: 'unsubscribed', unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, sub.id));
    }
  }

  return new NextResponse(
    htmlPage(
      "You've been unsubscribed",
      "You've been unsubscribed",
      "You won't receive any more emails from us. Your contact information stays on file but we won't email you.",
      true
    ),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'List-Unsubscribe': `<${new URL(request.url).href}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }
  );
}

// Support one-click unsubscribe (RFC 8058)
export async function POST(request: NextRequest) {
  return GET(request);
}
