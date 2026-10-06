#!/usr/bin/env node
/**
 * scripts/key-rotation.mjs (#2081) — machine checks for the AUTH_PRIVATE_KEY
 * rotation runbook, docs/security/node-key-roles-and-rotation.md.
 *
 *   preflight  Before the env swap. Pure: no database, no kernel. Refuses an
 *              unusable old/new pair and prints the AUTH_PREVIOUS_PUBLIC_KEY*
 *              values to set for the grace window.
 *                OLD_AUTH_PRIVATE_KEY=<current> NEW_AUTH_PRIVATE_KEY=<next> \
 *                  node scripts/key-rotation.mjs preflight [--grace-hours 48]
 *
 *   sign       Before the env swap, offline. Signs the rotation statement with
 *              BOTH keys and prints the PUBLIC payload (kids, public keys,
 *              effectiveAt, two signatures) as JSON on stdout — nothing secret.
 *              The old private key can be destroyed as soon as the swap is done.
 *                OLD_AUTH_PRIVATE_KEY=<current> NEW_AUTH_PRIVATE_KEY=<next> \
 *                  node scripts/key-rotation.mjs sign > key-rotated.json
 *
 *   submit     After the swap + restart. POSTs the payload to the kernel's
 *              admin endpoint, which re-verifies both signatures and files the
 *              node-issued `key.rotated` attestation.
 *                KERNEL_ADMIN_COOKIE='...' node scripts/key-rotation.mjs submit --payload key-rotated.json
 *
 *   verify     After submit, and any time later. Asks the kernel to verify the
 *              whole recorded key history against the key it is signing with.
 *              Exit 1 on any failure.
 *                KERNEL_ADMIN_COOKIE='...' node scripts/key-rotation.mjs verify [--anchor <old-public-key-hex>]
 *
 * KERNEL_ADMIN_COOKIE is the full Cookie header of a logged-in admin session
 * (same as scripts/migrate-vault-custody.mjs); KERNEL_BASE_URL defaults to
 * http://localhost:3000. Private keys are read from the environment only and
 * never printed. Exit codes: 0 ok, 1 a check failed, 2 bad usage.
 *
 * The crypto is `@imajin/auth/key-rotation`'s pre-built module — run after
 * `pnpm -r --filter './packages/**' build`, as the other deploy-time scripts do.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runKeyRotationCli } from './lib/key-rotation-cli.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY_ROTATION_BUILD = path.join(REPO_ROOT, 'packages', 'auth', 'dist', 'key-rotation.js');

if (!existsSync(KEY_ROTATION_BUILD)) {
  console.error(`key-rotation: ${KEY_ROTATION_BUILD} is missing — run \`pnpm --filter @imajin/auth... build\` first`);
  process.exit(2);
}

const keyRotation = await import(pathToFileURL(KEY_ROTATION_BUILD).href);

const code = await runKeyRotationCli(process.argv.slice(2), {
  keyRotation,
  env: process.env,
  fetchImpl: fetch,
  readFile,
  out: { log: (line) => console.log(line), error: (line) => console.error(line) },
});
process.exit(code);
