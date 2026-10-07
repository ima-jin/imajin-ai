#!/usr/bin/env tsx
/**
 * Reset database - DROP all schemas, recreate, and push fresh migrations
 *
 * ⚠️  DESTRUCTIVE - Only use in local development!
 */

import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapSequentially } from './lib/sequential.mjs';

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
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PNPM_CLI = require.resolve('pnpm/bin/pnpm.cjs');
const TSX_CLI = require.resolve('tsx/dist/cli.mjs');
const SAFE_EXEC_PATH = process.platform === 'win32'
  ? ['C:/Windows/System32', 'C:/Windows'].join(delimiter)
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);

// Sequential on purpose: schemas reference each other, so DDL runs one at a time in list order,
// and a failure on one schema is logged without stopping the rest.
function forEachSchema(buildSql: (schema: string) => string, done: string, failed: string): Promise<unknown> {
  return mapSequentially(schemas, async (schema) => {
    try {
      await sql.unsafe(buildSql(schema));
      console.log(`  ✅ ${done} ${schema}`);
    } catch (error) {
      console.error(`  ❌ Failed to ${failed} ${schema}:`, error);
    }
  });
}

async function main() {
  console.log('🔥 RESETTING DATABASE...\n');
  console.log('⚠️  This will DELETE ALL DATA!\n');

  // Drop all schemas
  console.log('💣 Dropping schemas...');
  await forEachSchema((schema) => `DROP SCHEMA IF EXISTS ${schema} CASCADE`, 'Dropped', 'drop');

  // Recreate schemas
  console.log('\n📦 Recreating schemas...');
  await forEachSchema((schema) => `CREATE SCHEMA ${schema}`, 'Created', 'create');

  await sql.end();

  // Push migrations for each service
  console.log('\n🚀 Pushing migrations...');
  const apps = [
    { dir: 'auth', pkg: '@imajin/auth-service' },
    { dir: 'chat', pkg: '@imajin/chat' },
    { dir: 'connections', pkg: '@imajin/connections-service' },
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
      if (!/^@imajin\/[a-z0-9-]+$/.test(app.pkg)) {
        throw new Error(`Unsafe package identifier: ${app.pkg}`);
      }
      execFileSync(process.execPath, [PNPM_CLI, '--filter', app.pkg, 'db:push'], {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL, PATH: SAFE_EXEC_PATH },
      });
      console.log(`  ✅ ${app.dir} schema pushed`);
    } catch (error) {
      console.error(`  ❌ Failed to push ${app.dir} schema:`, error);
    }
  }

  // Run seed
  console.log('\n🌱 Running seed...');
  execFileSync(process.execPath, [TSX_CLI, resolve(__dirname, 'seed.ts')], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL, PATH: SAFE_EXEC_PATH },
  });

  console.log('\n✨ Database reset complete!');
}

main().catch((error) => {
  console.error('💥 Reset failed:', error);
  process.exit(1);
});
