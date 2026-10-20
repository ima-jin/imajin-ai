#!/usr/bin/env node
/**
 * scripts/key-rotation.mjs (#2081) — machine checks for the AUTH_PRIVATE_KEY
 * rotation runbook, docs/security/node-key-roles-and-rotation.md.
 *
 *   generate   Mint and install a new Ed25519 seed in-process. Atomic 0600 env
 *              rewrite; exclusive 0600 <env-file>.key-rotation.bak rollback.
 *                node scripts/key-rotation.mjs generate --env-file apps/kernel/.env.local
 *
 *   destroy    Remove that backup after the rotation has been verified.
 *                node scripts/key-rotation.mjs destroy --env-file apps/kernel/.env.local
 *
 *   preflight  Offline check after generate: new key from the env file, old
 *              key from the adjacent .key-rotation.bak. No shell key transport.
 *                node -- scripts/key-rotation.mjs preflight --env-file apps/kernel/.env.local
 *
 *   sign       OFFLINE, AFTER the restart on the new key. Signs the rotation
 *              statement with BOTH keys and prints the PUBLIC payload (kids,
 *              public keys, effectiveAt, two signatures) as JSON on stdout —
 *              nothing secret. --effective-at is REQUIRED: the UTC instant the
 *              restarted kernel began signing with the new key. Anything the old
 *              key signed after that instant would later verify as invalid, so
 *              there is no "now" default. The old private key must still be held.
 *                node -- scripts/key-rotation.mjs sign --env-file apps/kernel/.env.local \
 *                  --effective-at 2026-10-06T12:00:00Z > key-rotated.json
 *
 *   submit     After the Phase 2 sweep. POSTs the payload to the kernel's
 *              admin endpoint, which re-verifies both signatures and files the
 *              node-issued `key.rotated` attestation.
 *              Legacy compatibility only; operators upload in /admin/keys.
 *
 *   verify     After submit, and any time later. Asks the kernel to verify the
 *              whole recorded key history against the key it is signing with.
 *              Exit 1 on any failure.
 *              Legacy compatibility only; operators verify in /admin/keys.
 *
 * KERNEL_ADMIN_COOKIE is the full Cookie header of a logged-in admin session
 * (same as scripts/migrate-vault-custody.mjs); KERNEL_BASE_URL defaults to
 * http://localhost:3000. `generate` reads the old key from the env file and
 * writes the new key there without shell transport. `sign --env-file` and
 * `preflight --env-file` use that file and its rollback backup, never shell
 * keys. Legacy preflight/sign without --env-file read keys from the environment;
 * this is not the operator runbook path. No private keys are printed.
 * Exit codes: 0 ok, 1 a check failed, 2 bad usage.
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

try {
  const keyRotation = await import(pathToFileURL(KEY_ROTATION_BUILD).href);
  const code = await runKeyRotationCli(process.argv.slice(2), {
    keyRotation,
    env: process.env,
    fetchImpl: fetch,
    readFile,
    out: { log: (line) => console.log(line), error: (line) => console.error(line) },
  });
  process.exit(code);
} catch {
  console.error('key-rotation: could not load or run rotation tooling; check the package build without printing secret material');
  process.exit(1);
}
