#!/usr/bin/env npx tsx
/**
 * Backfill mailing list subscriptions for users who opted in during registration.
 *
 * Queries profile.profiles where metadata->>'optInUpdates' = 'true' and
 * contact_email is set, then creates www.contacts + www.subscriptions rows
 * and sends verification emails for any not already subscribed.
 *
 * Usage:
 *   npx tsx scripts/backfill-mailing-list.ts            # live run
 *   npx tsx scripts/backfill-mailing-list.ts --dry-run  # preview only
 *
 * Requires: DATABASE_URL, SENDGRID_API_KEY, and optionally WWW_URL env vars
 */

import postgres from 'postgres';
import { createHmac } from 'crypto';

const DRY_RUN = process.argv.includes('--dry-run');
const DATABASE_URL = process.env.DATABASE_URL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM || 'Jin <jin@imajin.ai>';
const BASE_URL = process.env.WWW_URL || process.env.NEXT_PUBLIC_URL || 'https://imajin.ai';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

// ─── Token helpers (mirrors subscribe-tokens.ts) ─────────────────────────────

function getSecret(): string {
  return (
    process.env.HMAC_SECRET ||
    process.env.SUBSCRIBE_SECRET ||
    process.env.AUTH_INTERNAL_API_KEY ||
    'dev-fallback-secret'
  );
}

function verifyTokenExpiry(): number {
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
}

function generateVerifyToken(email: string, expiresAt: number): string {
  return createHmac('sha256', getSecret())
    .update(`${email}:verify:${expiresAt}`)
    .digest('hex');
}

// ─── Email helpers ────────────────────────────────────────────────────────────

function verificationEmailHtml(verifyUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
    <tr><td style="padding:40px 20px;">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" align="center" style="max-width:600px;margin:0 auto;">
        <tr>
          <td style="background-color:#111111;padding:32px 32px 24px;border-radius:8px 8px 0 0;">
            <h1 style="margin:0 0 8px;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Confirm your email</h1>
            <p style="margin:0;font-size:16px;color:#a1a1aa;line-height:1.5;">You're one click away from joining the Imajin updates list.</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#111111;padding:0 32px 24px;">
            <p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">Click the button below to confirm your email address. This link expires in 7 days.</p>
            <div style="text-align:center;">
              <a href="${verifyUrl}" style="display:inline-block;background-color:#f59e0b;color:#000000;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-0.2px;">Confirm my email →</a>
            </div>
            <p style="margin:24px 0 0;font-size:13px;color:#52525b;line-height:1.6;">Or copy and paste this link into your browser:<br/>
              <a href="${verifyUrl}" style="color:#71717a;word-break:break-all;">${verifyUrl}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#111111;padding:0 32px 32px;border-radius:0 0 8px 8px;">
            <div style="border-top:1px solid #262626;padding-top:20px;">
              <p style="margin:0;font-size:12px;color:#3f3f46;text-align:center;">If you didn't sign up for Imajin updates, you can safely ignore this email.</p>
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function verificationEmailText(verifyUrl: string): string {
  return `Confirm your email — Imajin\n\nYou're one click away from joining the Imajin updates list.\n\nConfirm your email: ${verifyUrl}\n\nThis link expires in 7 days. If you didn't sign up, ignore this email.\n\nImajin — The internet that pays you back\nhttps://imajin.ai`;
}

async function sendVerificationEmail(email: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.warn(`  ⚠️  SENDGRID_API_KEY not set — skipping email to ${email}`);
    return false;
  }

  const expiresAt = verifyTokenExpiry();
  const token = generateVerifyToken(email, expiresAt);
  const verifyUrl = `${BASE_URL}/api/subscribe/verify?email=${encodeURIComponent(email)}&token=${token}&expires=${expiresAt}`;

  const sender = parseSender(SENDGRID_FROM);
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: sender,
      subject: 'Confirm your email — Imajin',
      content: [
        { type: 'text/plain', value: verificationEmailText(verifyUrl) },
        { type: 'text/html', value: verificationEmailHtml(verifyUrl) },
      ],
    }),
  });

  if (res.status === 202) {
    return true;
  }
  const body = await res.text();
  console.error(`  SendGrid error for ${email}: ${res.status} ${body}`);
  return false;
}

function parseSender(from: string): { email: string; name?: string } {
  const match = from.match(/^(.+)\s*<(.+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN
    ? '🔍 DRY RUN — no changes will be written\n'
    : '✏️  LIVE RUN — subscribing opted-in users\n');
  console.log(`Base URL for verify links: ${BASE_URL}\n`);

  // Find all profiles where optInUpdates = true and contact_email is set
  const optedIn = await sql<{ did: string; email: string }[]>`
    SELECT did, contact_email AS email
    FROM profile.profiles
    WHERE metadata->>'optInUpdates' = 'true'
      AND contact_email IS NOT NULL
      AND contact_email != ''
    ORDER BY created_at
  `;

  console.log(`Found ${optedIn.length} opted-in profile(s) with an email address\n`);

  if (optedIn.length === 0) {
    await sql.end();
    return;
  }

  // Ensure the 'updates' mailing list exists
  let listId: string;
  const [existingList] = await sql<{ id: string }[]>`
    SELECT id FROM www.mailing_lists WHERE slug = 'updates' LIMIT 1
  `;

  if (existingList) {
    listId = existingList.id;
  } else if (DRY_RUN) {
    listId = '<would-create>';
    console.log('  [DRY RUN] Would create www.mailing_lists row (slug=updates)\n');
  } else {
    const [newList] = await sql<{ id: string }[]>`
      INSERT INTO www.mailing_lists (slug, name, description)
      VALUES ('updates', 'Imajin Updates', 'Progress updates on sovereign infrastructure')
      RETURNING id
    `;
    listId = newList.id;
    console.log(`Created mailing list: ${listId}\n`);
  }

  let created = 0;
  let resubscribed = 0;
  let alreadySubscribed = 0;
  let emailsSent = 0;
  let skipped = 0;

  for (const { did, email } of optedIn) {
    const normalizedEmail = email.toLowerCase().trim();
    console.log(`Processing ${did} → ${normalizedEmail}`);

    // Check existing contact
    const [existingContact] = await sql<{ id: string; is_verified: boolean }[]>`
      SELECT id, is_verified FROM www.contacts WHERE email = ${normalizedEmail} LIMIT 1
    `;

    if (existingContact) {
      // Check subscription
      const [existingSub] = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM www.subscriptions WHERE contact_id = ${existingContact.id} LIMIT 1
      `;

      if (existingSub && existingSub.status === 'subscribed') {
        console.log(`  ✓ Already subscribed (verified=${existingContact.is_verified})`);
        alreadySubscribed++;

        // Still send verification email if not verified
        if (!existingContact.is_verified) {
          if (DRY_RUN) {
            console.log('  [DRY RUN] Would send verification email');
          } else {
            const sent = await sendVerificationEmail(normalizedEmail);
            if (sent) {
              console.log('  📧 Sent verification email');
              emailsSent++;
            }
          }
        }
        continue;
      }

      if (existingSub) {
        // Resubscribe
        if (DRY_RUN) {
          console.log('  [DRY RUN] Would resubscribe (was unsubscribed)');
        } else {
          await sql`
            UPDATE www.subscriptions
            SET status = 'subscribed', subscribed_at = NOW(), unsubscribed_at = NULL
            WHERE id = ${existingSub.id}
          `;
          console.log('  ↩️  Resubscribed');
          resubscribed++;
        }
      } else {
        // Create subscription
        if (DRY_RUN) {
          console.log('  [DRY RUN] Would create subscription');
        } else {
          await sql`
            INSERT INTO www.subscriptions (contact_id, mailing_list_id)
            VALUES (${existingContact.id}, ${listId})
            ON CONFLICT DO NOTHING
          `;
          console.log('  ➕ Created subscription');
          resubscribed++;
        }
      }

      if (!existingContact.is_verified) {
        if (DRY_RUN) {
          console.log('  [DRY RUN] Would send verification email');
        } else {
          const sent = await sendVerificationEmail(normalizedEmail);
          if (sent) {
            console.log('  📧 Sent verification email');
            emailsSent++;
          }
        }
      }
    } else {
      // Create contact + subscription, send verification email
      if (DRY_RUN) {
        console.log('  [DRY RUN] Would create contact, subscription, and send verification email');
        created++;
      } else {
        const [newContact] = await sql<{ id: string }[]>`
          INSERT INTO www.contacts (email, source, is_verified)
          VALUES (${normalizedEmail}, 'register', false)
          ON CONFLICT (email) DO NOTHING
          RETURNING id
        `;

        if (!newContact) {
          console.log('  ⚠️  Contact insert returned nothing (race condition?), skipping');
          skipped++;
          continue;
        }

        await sql`
          INSERT INTO www.subscriptions (contact_id, mailing_list_id)
          VALUES (${newContact.id}, ${listId})
          ON CONFLICT DO NOTHING
        `;

        const sent = await sendVerificationEmail(normalizedEmail);
        console.log(`  ✅ Created contact + subscription${sent ? ', 📧 sent verification email' : ''}`);
        created++;
        if (sent) emailsSent++;
      }
    }
  }

  console.log(`
✅ Done:
   ${created} new contacts + subscriptions created
   ${resubscribed} resubscribed
   ${alreadySubscribed} already subscribed
   ${emailsSent} verification emails sent
   ${skipped} skipped (errors)`);

  await sql.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
