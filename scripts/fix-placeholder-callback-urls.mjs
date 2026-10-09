#!/usr/bin/env node
/**
 * One-off owner script (#2746): rewrite `registry.apps` rows whose
 * `callback_url` / `redirect_uris` still use the `your-node.imajin.ai`
 * placeholder host to this node's real public origin.
 *
 * Why a script and not a migration: SQL cannot know which node it runs on, and
 * a migration would bake one host into every node's history. The host is an
 * operator input.
 *
 * DRY-RUN BY DEFAULT: prints every row it would touch and writes nothing.
 * Pass `--apply` to update them (single transaction). Only rows whose host is
 * still the placeholder are ever touched — rows already hot-fixed by hand are
 * left alone.
 *
 * Usage (run on dev and on prod, each with its own origin):
 *   node scripts/fix-placeholder-callback-urls.mjs --origin https://dev-jin.imajin.ai
 *   node scripts/fix-placeholder-callback-urls.mjs --origin https://jin.imajin.ai --apply
 *
 * `--origin` defaults to APP_URL, then NEXT_PUBLIC_BASE_URL (process env, then
 * apps/kernel/.env.local). DATABASE_URL is read the same way.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import envUtils from './env-utils.js';
import { fixPlaceholderCallbackUrls, parseNodeOrigin } from './lib/placeholder-callback-urls.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const kernelDir = resolve(__dirname, '..', 'apps', 'kernel');
const envPath = resolve(kernelDir, '.env.local');

function readConfig(key) {
  return process.env[key] || envUtils.readEnvValueFromFile(envPath, key);
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main() {
  let origin;
  try {
    origin = parseNodeOrigin(argValue('--origin') || readConfig('APP_URL') || readConfig('NEXT_PUBLIC_BASE_URL'));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const databaseUrl = readConfig('DATABASE_URL');
  if (!databaseUrl) {
    console.error(`❌ No DATABASE_URL found in ${envPath} or environment`);
    process.exit(1);
  }

  const kernelRequire = createRequire(join(kernelDir, 'index.js'));
  const postgres = kernelRequire('postgres');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await fixPlaceholderCallbackUrls({ sql, origin, apply: process.argv.includes('--apply') });
  } finally {
    await sql.end();
  }
}

await main();
