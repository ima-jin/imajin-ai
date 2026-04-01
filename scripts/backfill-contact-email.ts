#!/usr/bin/env npx tsx
/**
 * Backfill contact_email on auth.identities from Stripe billing details.
 *
 * For each identity missing contact_email:
 * 1. Look up their ticket(s) in events.tickets via owner_did
 * 2. Get the payment_id from the ticket
 * 3. Fetch the Stripe PaymentIntent (with charges expanded) to get billing_details.email
 * 4. Update auth.identities.contact_email
 *
 * Falls back to auth.credentials (type='email') when no Stripe payment is found.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/backfill-contact-email.ts   # preview only
 *   npx tsx scripts/backfill-contact-email.ts              # apply updates
 *
 * Requires: DATABASE_URL, STRIPE_SECRET_KEY env vars
 */

import postgres from 'postgres';

const DRY_RUN = process.env.DRY_RUN === '1';
const DATABASE_URL = process.env.DATABASE_URL;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

interface IdentityRow {
  did: string;
  name: string | null;
}

interface TicketRow {
  ticket_id: string;
  payment_id: string | null;
  purchase_email: string | null;
}

interface CredentialRow {
  value: string;
}

async function fetchStripeEmail(paymentId: string): Promise<string | null> {
  // payment_id may be a PaymentIntent (pi_xxx) or a Checkout Session ID (cs_xxx).
  // For checkout sessions, expand payment_intent.charges.data.
  // For payment intents, expand charges.data directly.

  try {
    if (paymentId.startsWith('cs_')) {
      // Checkout Session — fetch session and follow the payment_intent
      const res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${paymentId}?expand[]=payment_intent.charges`,
        {
          headers: {
            Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          },
        }
      );

      if (!res.ok) {
        const text = await res.text();
        console.warn(`  Stripe session fetch failed for ${paymentId}: ${res.status} ${text}`);
        return null;
      }

      const session = await res.json();
      const charges = session?.payment_intent?.charges?.data;
      if (Array.isArray(charges) && charges.length > 0) {
        return charges[0]?.billing_details?.email ?? null;
      }
      // Fallback: customer_email on session
      return session?.customer_email ?? null;
    } else {
      // PaymentIntent (pi_xxx)
      const res = await fetch(
        `https://api.stripe.com/v1/payment_intents/${paymentId}?expand[]=charges`,
        {
          headers: {
            Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          },
        }
      );

      if (!res.ok) {
        const text = await res.text();
        console.warn(`  Stripe PI fetch failed for ${paymentId}: ${res.status} ${text}`);
        return null;
      }

      const pi = await res.json();
      const charges = pi?.charges?.data;
      if (Array.isArray(charges) && charges.length > 0) {
        return charges[0]?.billing_details?.email ?? null;
      }
      return null;
    }
  } catch (err) {
    console.warn(`  Stripe fetch error for ${paymentId}:`, err);
    return null;
  }
}

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — no updates will be written\n' : '✏️  LIVE RUN — updating contact_email\n');

  // 1. Find all identities missing contact_email
  const identities: IdentityRow[] = await sql`
    SELECT id as did, name
    FROM auth.identities
    WHERE contact_email IS NULL
    ORDER BY created_at
  `;

  console.log(`Found ${identities.length} identities missing contact_email\n`);

  let updated = 0;
  let fromStripe = 0;
  let fromCredential = 0;
  let skipped = 0;

  for (const identity of identities) {
    const { did } = identity;

    // 2. Look up tickets for this identity
    const tickets: TicketRow[] = await sql`
      SELECT
        id as ticket_id,
        payment_id,
        metadata->>'purchaseEmail' as purchase_email
      FROM events.tickets
      WHERE owner_did = ${did}
        AND payment_id IS NOT NULL
      ORDER BY purchased_at DESC
      LIMIT 1
    `;

    let email: string | null = null;
    let source = '';

    if (tickets.length > 0) {
      const ticket = tickets[0];

      // 3. Try purchase email from metadata first (fast, no Stripe call needed)
      if (ticket.purchase_email) {
        email = ticket.purchase_email.toLowerCase().trim();
        source = 'ticket.metadata.purchaseEmail';
      }

      // 4. If not in metadata, fetch from Stripe billing details
      if (!email && ticket.payment_id) {
        email = await fetchStripeEmail(ticket.payment_id);
        if (email) {
          email = email.toLowerCase().trim();
          source = `stripe(${ticket.payment_id})`;
          fromStripe++;
        }
      }
    }

    // 5. Fallback: auth.credentials (type='email')
    if (!email) {
      const creds: CredentialRow[] = await sql`
        SELECT value
        FROM auth.credentials
        WHERE did = ${did}
          AND type = 'email'
        LIMIT 1
      `;
      if (creds.length > 0) {
        email = creds[0].value.toLowerCase().trim();
        source = 'auth.credentials';
        fromCredential++;
      }
    }

    if (!email) {
      console.log(`  ⚠️  ${did} — no email found, skipping`);
      skipped++;
      continue;
    }

    console.log(`  ${DRY_RUN ? '[DRY RUN] Would update' : 'Updating'} ${did} → ${email} (via ${source})`);

    if (!DRY_RUN) {
      await sql`
        UPDATE auth.identities
        SET contact_email = ${email},
            updated_at = NOW()
        WHERE id = ${did}
          AND contact_email IS NULL
      `;
      updated++;
    } else {
      updated++;
    }

    // Small delay to avoid Stripe rate limits when calling API
    if (!DRY_RUN && source.startsWith('stripe')) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`
✅ Done:
   ${updated} updated (${fromStripe} from Stripe, ${fromCredential} from credentials, ${updated - fromStripe - fromCredential} from ticket metadata)
   ${skipped} skipped (no email found)`);

  await sql.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
