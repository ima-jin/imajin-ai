#!/usr/bin/env npx tsx
/**
 * Report DFOS chain bridging status.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/check-dfos-chains.ts
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  const sql = postgres(DATABASE_URL!);

  try {
    const total = await sql`SELECT COUNT(*) AS count FROM auth.identities`;
    const withKeys = await sql`
      SELECT COUNT(*) AS count FROM auth.identities
      WHERE public_key ~ '^[0-9a-f]{64}$'
    `;
    const withChains = await sql`SELECT COUNT(*) AS count FROM auth.identity_chains`;
    const soft = await sql`
      SELECT COUNT(*) AS count FROM auth.identities
      WHERE public_key LIKE 'soft_%'
    `;

    // List bridged identities
    const bridged = await sql`
      SELECT ic.did, ic.dfos_did, i.handle, i.tier, i.type
      FROM auth.identity_chains ic
      JOIN auth.identities i ON i.id = ic.did
      ORDER BY ic.created_at
    `;

    // List unbridged identities with real keys
    const unbridged = await sql`
      SELECT i.id, i.handle, i.tier, i.type
      FROM auth.identities i
      WHERE i.public_key ~ '^[0-9a-f]{64}$'
        AND i.id NOT IN (SELECT did FROM auth.identity_chains)
      ORDER BY i.created_at
    `;

    console.log('DFOS Chain Status');
    console.log('═'.repeat(50));
    console.log(`Total identities:      ${total[0].count}`);
    console.log(`With real keys:        ${withKeys[0].count}`);
    console.log(`With DFOS chains:      ${withChains[0].count}`);
    console.log(`Soft (no key):         ${soft[0].count}`);
    console.log(`Pending bridge:        ${unbridged.length}`);
    console.log('');

    if (bridged.length > 0) {
      console.log('✅ Bridged:');
      for (const b of bridged) {
        console.log(`   ${b.handle || b.did} (${b.tier}/${b.type}) → ${b.dfos_did}`);
      }
      console.log('');
    }

    if (unbridged.length > 0) {
      console.log('⏳ Pending (will bridge on next login):');
      for (const u of unbridged) {
        console.log(`   ${u.handle || u.id} (${u.tier}/${u.type})`);
      }
    }
  } finally {
    await sql.end();
  }
}

main();
