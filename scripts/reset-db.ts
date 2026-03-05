#!/usr/bin/env tsx
/**
 * Reset database - DROP all schemas, recreate, and push fresh migrations
 *
 * ⚠️  DESTRUCTIVE - Only use in local development!
 */

import postgres from 'postgres';
import { execSync } from 'child_process';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

// Safety check - prevent running against production
if (DATABASE_URL.includes('prod') || DATABASE_URL.includes('railway') || DATABASE_URL.includes('supabase')) {
  console.error('❌ This script cannot be run against production databases!');
  console.error('   Detected production-like URL. Aborting.');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

const schemas = ['auth', 'chat', 'coffee', 'connections', 'dykil', 'events', 'links', 'pay', 'profile', 'registry', 'www'];

async function main() {
  console.log('🔥 RESETTING DATABASE...\n');
  console.log('⚠️  This will DELETE ALL DATA!\n');

  // Drop all schemas
  console.log('💣 Dropping schemas...');
  for (const schema of schemas) {
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      console.log(`  ✅ Dropped ${schema}`);
    } catch (error) {
      console.error(`  ❌ Failed to drop ${schema}:`, error);
    }
  }

  // Recreate schemas
  console.log('\n📦 Recreating schemas...');
  for (const schema of schemas) {
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      console.log(`  ✅ Created ${schema}`);
    } catch (error) {
      console.error(`  ❌ Failed to create ${schema}:`, error);
    }
  }

  await sql.end();

  // Push migrations for each service
  console.log('\n🚀 Pushing migrations...');
  const apps = [
    { dir: 'auth', pkg: '@imajin/auth-service' },
    { dir: 'chat', pkg: '@imajin/chat' },
    { dir: 'coffee', pkg: '@imajin/coffee-service' },
    { dir: 'connections', pkg: '@imajin/connections-service' },
    { dir: 'dykil', pkg: '@imajin/dykil-service' },
    { dir: 'events', pkg: '@imajin/events' },
    { dir: 'links', pkg: '@imajin/links-service' },
    { dir: 'pay', pkg: '@imajin/pay-service' },
    { dir: 'profile', pkg: '@imajin/profile-service' },
    { dir: 'registry', pkg: '@imajin/registry-service' },
    { dir: 'www', pkg: '@imajin/www' },
  ];

  for (const app of apps) {
    try {
      console.log(`  📝 ${app.dir}...`);
      execSync(`pnpm --filter ${app.pkg} db:push`, {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL },
      });
      console.log(`  ✅ ${app.dir} schema pushed`);
    } catch (error) {
      console.error(`  ❌ Failed to push ${app.dir} schema`);
    }
  }

  // Run seed
  console.log('\n🌱 Running seed...');
  execSync('tsx scripts/seed.ts', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL },
  });

  console.log('\n✨ Database reset complete!');
}

main().catch((error) => {
  console.error('💥 Reset failed:', error);
  process.exit(1);
});
