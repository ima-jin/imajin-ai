#!/usr/bin/env tsx
/**
 * Local demo data setup
 *
 * Copy this to launch-local.ts and customize for your local development needs.
 * launch-local.ts is gitignored so you can add personal test data.
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

async function main() {
  console.log('🚀 Setting up local demo data...\n');

  // Example: Create a test user profile
  console.log('👤 Creating test profiles...');
  try {
    await sql`
      INSERT INTO profile.profiles (did, handle, display_name, display_type, bio)
      VALUES
        ('did:imajin:alice', 'alice', 'Alice', 'human', 'Test user'),
        ('did:imajin:bob', 'bob', 'Bob', 'human', 'Another test user')
      ON CONFLICT (did) DO NOTHING
    `;
    console.log('  ✅ Test profiles created');
  } catch (error) {
    console.error('  ❌ Failed to create profiles:', error);
  }

  // Example: Create a coffee page
  console.log('\n☕ Creating test coffee page...');
  try {
    await sql`
      INSERT INTO coffee.pages (id, did, handle, title, bio, avatar, payment_methods, presets)
      VALUES (
        'page_demo',
        'did:imajin:alice',
        'alice',
        'Buy Alice a coffee',
        'Support my work!',
        '☕',
        '{"stripe": {"enabled": false}, "solana": {"enabled": false}}'::jsonb,
        ARRAY[100, 500, 1000]
      )
      ON CONFLICT (id) DO NOTHING
    `;
    console.log('  ✅ Coffee page created');
  } catch (error) {
    console.error('  ❌ Failed to create coffee page:', error);
  }

  // Add more demo data as needed...

  await sql.end();
  console.log('\n✨ Demo data setup complete!');
}

main().catch((error) => {
  console.error('💥 Demo data setup failed:', error);
  process.exit(1);
});
