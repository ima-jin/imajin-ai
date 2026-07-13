/**
 * scripts/migrate-contact-to-vault.ts
 *
 * One-time operator script: migrates plaintext contact_email and phone columns
 * from profile.profiles into the vault and contact_hashes table, then nulls
 * out the plaintext columns.
 *
 * Run ONCE on dev, verify the round-trip, then run on prod.
 * NEVER auto-run this script from migrations — operator-triggered only.
 *
 * Usage (from repo root):
 *   npx tsx scripts/migrate-contact-to-vault.ts
 *
 * Required env vars:
 *   DATABASE_URL      — postgres connection string
 *   AUTH_PRIVATE_KEY  — node signing + seal key (same as kernel)
 *   VAULT_PATH        — optional; defaults to ~/.imajin/vault.json
 */

import { createHash } from 'node:crypto';
import { getClient } from '@imajin/db';
import { sealAndStore, loadAndUnseal } from '../apps/kernel/src/lib/vault/index.js';

const sql = getClient();

interface ProfileRow {
  did: string;
  contact_email: string | null;
  phone: string | null;
}

/** Migrate a single profile row: seal contact fields, hash, backfill credentials, verify, null columns. */
async function migrateProfileRow(row: ProfileRow): Promise<void> {
  const { did, contact_email, phone } = row;

  if (contact_email) {
    const emailField = `contact:email:${did}`;
    const existing = await loadAndUnseal(emailField).catch(() => undefined);
    if (!existing) {
      await sealAndStore(emailField, contact_email);
      console.log(`  [email] sealed for ${did.slice(0, 20)}…`);
    } else {
      console.log(`  [email] already in vault for ${did.slice(0, 20)}… — skipping seal`);
    }

    const emailHash = createHash('sha256').update(contact_email.toLowerCase().trim()).digest('hex');
    await sql`
      INSERT INTO profile.contact_hashes (did, email_hash, updated_at)
      VALUES (${did}, ${emailHash}, now())
      ON CONFLICT (did) DO UPDATE
        SET email_hash = ${emailHash}, updated_at = now()
    `;

    const normalised = contact_email.toLowerCase().trim();
    const credId = 'cred_' + createHash('sha256').update(did + normalised).digest('hex').slice(0, 24);
    await sql`
      INSERT INTO auth.credentials (id, did, type, value, verified_at)
      VALUES (${credId}, ${did}, 'email', ${normalised}, now())
      ON CONFLICT (type, value) DO NOTHING
    `;
  }

  if (phone) {
    const phoneField = `contact:phone:${did}`;
    const existing = await loadAndUnseal(phoneField).catch(() => undefined);
    if (!existing) {
      await sealAndStore(phoneField, phone);
      console.log(`  [phone] sealed for ${did.slice(0, 20)}…`);
    } else {
      console.log(`  [phone] already in vault for ${did.slice(0, 20)}… — skipping seal`);
    }

    const phoneHash = createHash('sha256').update(phone.toLowerCase().trim()).digest('hex');
    await sql`
      INSERT INTO profile.contact_hashes (did, phone_hash, updated_at)
      VALUES (${did}, ${phoneHash}, now())
      ON CONFLICT (did) DO UPDATE
        SET phone_hash = ${phoneHash}, updated_at = now()
    `;
  }

  // Verify round-trip before nulling plaintext columns
  if (contact_email) {
    const recovered = await loadAndUnseal(`contact:email:${did}`);
    if (recovered !== contact_email) {
      throw new Error(`Round-trip mismatch for email on ${did}: expected "${contact_email}", got "${recovered}"`);
    }
  }
  if (phone) {
    const recovered = await loadAndUnseal(`contact:phone:${did}`);
    if (recovered !== phone) {
      throw new Error(`Round-trip mismatch for phone on ${did}: expected "${phone}", got "${recovered}"`);
    }
  }

  await sql`
    UPDATE profile.profiles
    SET contact_email = NULL, phone = NULL
    WHERE did = ${did}
  `;
}

async function main() {
  console.log('=== Contact vault migration ===');

  const rows = await sql<ProfileRow[]>`
    SELECT did, contact_email, phone
    FROM profile.profiles
    WHERE contact_email IS NOT NULL
       OR phone IS NOT NULL
  `;

  console.log(`Found ${rows.length} profiles with plaintext contact info.`);

  let successCount = 0;
  let failCount = 0;

  for (const row of rows) {
    try {
      await migrateProfileRow(row);
      successCount++;
    } catch (err) {
      console.error(`  FAILED for ${row.did}:`, err);
      failCount++;
      // Continue — do not abort the whole migration on a single failure
    }
  }

  console.log(`\nDone. ${successCount} migrated, ${failCount} failed.`);
  if (failCount > 0) {
    console.error('Some rows failed — review errors above before running on prod.');
    process.exit(1);
  }

  await sql.end();
}

main().catch((err) => {
  console.error('Migration fatal error:', err);
  process.exit(1);
});
