#!/usr/bin/env tsx
/**
 * Seed essential data for local development
 *
 * Idempotent - safe to run multiple times
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

async function main() {
  console.log('🌱 Seeding database...\n');

  // Create all schemas
  const schemas = ['auth', 'chat', 'coffee', 'connections', 'dykil', 'events', 'links', 'pay', 'profile', 'registry', 'www'];

  console.log('📦 Ensuring schemas exist...');
  for (const schema of schemas) {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    console.log(`  ✅ ${schema}`);
  }

  // Seed Jin profile
  console.log('\n👤 Seeding Jin profile...');
  try {
    const jinDid = 'did:imajin:jin';
    const jinHandle = 'jin';

    // Check if Jin already exists
    const existing = await sql`
      SELECT did FROM profile.profiles WHERE did = ${jinDid}
    `;

    if (existing.length > 0) {
      console.log('  ⏭️  Jin profile already exists');
    } else {
      await sql`
        INSERT INTO profile.profiles (
          did,
          handle,
          display_name,
          display_type,
          avatar,
          bio,
          created_at,
          updated_at
        ) VALUES (
          ${jinDid},
          ${jinHandle},
          'Jin',
          'human',
          '🟠',
          'The presence. 🟠',
          NOW(),
          NOW()
        )
      `;
      console.log('  ✅ Jin profile created');
    }
  } catch (error) {
    console.error('  ❌ Failed to seed Jin profile:', error);
  }

  await sql.end();
  console.log('\n✨ Seeding complete!');
}

main().catch((error) => {
  console.error('💥 Seeding failed:', error);
  process.exit(1);
});
