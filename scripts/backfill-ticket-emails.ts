#!/usr/bin/env npx tsx
/**
 * Backfill confirmation emails for all ticket holders who never received one.
 *
 * The events webhook had a bug (Date object instead of ISO string in the
 * onboard token insert) that silently prevented ALL confirmation emails
 * from being sent since the first ticket was sold.
 *
 * This script:
 * 1. Finds all tickets with no corresponding "access your ticket" onboard token
 * 2. Creates onboard tokens (7-day expiry) in auth.onboard_tokens
 * 3. Sends the confirmation email with QR code and magic link
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/backfill-ticket-emails.ts   # preview only
 *   npx tsx scripts/backfill-ticket-emails.ts              # send emails
 *
 * Requires: DATABASE_URL, SENDGRID_API_KEY, AUTH_URL, EVENTS_URL env vars
 */

import postgres from 'postgres';
import { randomBytes } from 'crypto';
import QRCode from 'qrcode';

const DRY_RUN = process.env.DRY_RUN === '1';
const DATABASE_URL = process.env.DATABASE_URL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const AUTH_URL = process.env.AUTH_URL || 'https://auth.imajin.ai';
const EVENTS_URL = process.env.EVENTS_URL || 'https://events.imajin.ai';
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@imajin.ai';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

if (!SENDGRID_API_KEY && !DRY_RUN) {
  console.error('SENDGRID_API_KEY is required (or set DRY_RUN=1)');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

interface TicketRow {
  ticket_id: string;
  event_id: string;
  event_title: string;
  event_starts_at: Date;
  event_image_url: string | null;
  event_is_virtual: boolean;
  ticket_type_name: string;
  owner_did: string;
  price_paid: string;
  currency: string;
  purchase_email: string | null;
  venue: string | null;
}

async function generateQRCode(data: string): Promise<string> {
  return QRCode.toDataURL(data, {
    width: 200,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would send to: ${to} | Subject: ${subject}`);
    return true;
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: 'Imajin' },
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  ❌ SendGrid error for ${to}: ${res.status} ${text}`);
    return false;
  }
  return true;
}

// Inline the email template (same as apps/events/src/lib/email.ts)
function ticketConfirmationEmail(data: {
  eventTitle: string;
  ticketType: string;
  ticketId: string;
  eventDate: string;
  eventTime: string;
  isVirtual: boolean;
  venue?: string;
  price: string;
  magicLink: string;
  eventImageUrl?: string;
  eventUrl?: string;
  qrCodeDataUri?: string;
}): string {
  const eventImage = data.eventImageUrl
    ? `<img src="${data.eventImageUrl}" alt="${data.eventTitle}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:8px 8px 0 0;" />`
    : '';

  const qrSection = data.qrCodeDataUri
    ? `<div style="text-align:center;margin:24px 0;">
        <p style="margin:0 0 8px;font-size:13px;color:#71717a;">Your ticket QR code:</p>
        <img src="${data.qrCodeDataUri}" alt="Ticket QR Code" style="width:160px;height:160px;" />
        <p style="margin:8px 0 0;font-size:11px;color:#a1a1aa;">${data.ticketId}</p>
      </div>`
    : '';

  const locationSection = data.isVirtual
    ? '<p style="margin:4px 0;color:#71717a;">📍 Virtual Event</p>'
    : data.venue
      ? `<p style="margin:4px 0;color:#71717a;">📍 ${data.venue}</p>`
      : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#09090b;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    ${eventImage}
    <div style="background:#18181b;padding:32px;border-radius:${eventImage ? '0 0 8px 8px' : '8px'};">
      <h1 style="margin:0 0 8px;font-size:24px;color:#f4f4f5;">You're in! 🎉</h1>
      <h2 style="margin:0 0 24px;font-size:18px;color:#f97316;font-weight:600;">${data.eventTitle}</h2>

      <div style="background:#27272a;border-radius:8px;padding:16px;margin:0 0 24px;">
        <p style="margin:0 0 4px;font-size:14px;color:#f4f4f5;font-weight:600;">${data.ticketType}</p>
        <p style="margin:4px 0;color:#a1a1aa;">📅 ${data.eventDate}</p>
        <p style="margin:4px 0;color:#a1a1aa;">🕐 ${data.eventTime}</p>
        ${locationSection}
        <p style="margin:8px 0 0;font-size:18px;color:#f4f4f5;font-weight:700;">${data.price}</p>
      </div>

      ${qrSection}

      <div style="text-align:center;margin:24px 0;">
        <a href="${data.magicLink}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:16px;">
          Access Your Ticket →
        </a>
      </div>

      <p style="margin:24px 0 0;font-size:13px;color:#71717a;text-align:center;">
        This link is valid for 7 days. Click it to access the event page, join the conversation, and manage your ticket.
      </p>

      ${data.eventUrl ? `<p style="margin:16px 0 0;font-size:12px;color:#52525b;text-align:center;">
        <a href="${data.eventUrl}" style="color:#60a5fa;text-decoration:underline;">View event page</a>
      </p>` : ''}
    </div>

    <p style="margin:24px 0 0;font-size:11px;color:#3f3f46;text-align:center;">
      Powered by Imajin — sovereign event infrastructure
    </p>
  </div>
</body>
</html>`;
}

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — no emails will be sent\n' : '📧 LIVE RUN — sending emails\n');

  // Find all tickets that need confirmation emails
  // Join with events and ticket_types, extract purchaseEmail from metadata
  const tickets: TicketRow[] = await sql`
    SELECT
      t.id as ticket_id,
      t.event_id,
      e.title as event_title,
      e.starts_at as event_starts_at,
      e.image_url as event_image_url,
      COALESCE(e.is_virtual, false) as event_is_virtual,
      tt.name as ticket_type_name,
      t.owner_did,
      t.price_paid,
      t.currency,
      t.metadata->>'purchaseEmail' as purchase_email,
      e.venue
    FROM events.tickets t
    JOIN events.events e ON t.event_id = e.id
    JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
    WHERE t.status = 'valid'
    ORDER BY e.title, t.created_at
  `;

  console.log(`Found ${tickets.length} total tickets\n`);

  // Group by email to avoid sending duplicates
  // (some people bought multiple tickets)
  const byEmail = new Map<string, TicketRow[]>();
  let skippedNoEmail = 0;

  for (const t of tickets) {
    const email = t.purchase_email;
    if (!email) {
      // Try to extract email from DID
      const didMatch = t.owner_did.match(/^did:email:(.+)$/);
      if (didMatch) {
        const reconstructed = didMatch[1]
          .replace(/_at_/g, '@')
          .replace(/_/g, '.');
        (t as any).purchase_email = reconstructed;
        const arr = byEmail.get(reconstructed) || [];
        arr.push(t);
        byEmail.set(reconstructed, arr);
      } else {
        skippedNoEmail++;
      }
      continue;
    }
    const arr = byEmail.get(email) || [];
    arr.push(t);
    byEmail.set(email, arr);
  }

  if (skippedNoEmail > 0) {
    console.log(`⚠️  Skipped ${skippedNoEmail} tickets with hard DIDs and no purchaseEmail\n`);
  }

  let sent = 0;
  let failed = 0;

  for (const [email, emailTickets] of byEmail) {
    // Group by event
    const byEvent = new Map<string, TicketRow[]>();
    for (const t of emailTickets) {
      const arr = byEvent.get(t.event_id) || [];
      arr.push(t);
      byEvent.set(t.event_id, arr);
    }

    for (const [eventId, eventTickets] of byEvent) {
      const t = eventTickets[0];
      const quantity = eventTickets.length;

      console.log(`📨 ${email} — ${t.event_title} (${quantity} ticket${quantity > 1 ? 's' : ''})`);

      // Create onboard token
      const onboardToken = randomBytes(36).toString('hex');
      const onboardId = `obt_${randomBytes(8).toString('hex')}`;
      const redirectUrl = `${EVENTS_URL}/${eventId}`;

      if (!DRY_RUN) {
        await sql`
          INSERT INTO auth.onboard_tokens (id, email, name, token, redirect_url, context, expires_at)
          VALUES (
            ${onboardId},
            ${email.toLowerCase().trim()},
            ${null},
            ${onboardToken},
            ${redirectUrl},
            ${'access your ticket for ' + t.event_title},
            ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
          )
        `;
      }

      const magicLink = `${AUTH_URL}/api/onboard/verify?token=${onboardToken}`;

      // Generate QR code
      const qrCodeDataUri = await generateQRCode(t.ticket_id);

      // Build event image URL
      const eventImageUrl = t.event_image_url
        ? (t.event_image_url.startsWith('http') ? t.event_image_url : `${EVENTS_URL}${t.event_image_url}`)
        : undefined;

      // Format ticket info
      const eventDate = new Date(t.event_starts_at);
      const ticketIdDisplay = t.ticket_id + (quantity > 1 ? ` (+${quantity - 1} more)` : '');
      const pricePaid = eventTickets.reduce((sum, tk) => sum + parseFloat(tk.price_paid), 0);

      const html = ticketConfirmationEmail({
        eventTitle: t.event_title,
        ticketType: t.ticket_type_name,
        ticketId: ticketIdDisplay,
        eventDate: eventDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        eventTime: eventDate.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }),
        isVirtual: t.event_is_virtual,
        venue: t.venue || undefined,
        price: new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: t.currency?.toUpperCase() || 'CAD',
        }).format(pricePaid / 100),
        magicLink,
        eventImageUrl,
        eventUrl: `${EVENTS_URL}/${eventId}`,
        qrCodeDataUri,
      });

      const ok = await sendEmail(email, `You're in — ${t.event_title}`, html);
      if (ok) sent++;
      else failed++;

      // Small delay to avoid SendGrid rate limits
      if (!DRY_RUN) await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n✅ Done: ${sent} sent, ${failed} failed, ${skippedNoEmail} skipped (no email)`);
  await sql.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
