#!/usr/bin/env node
/**
 * Vault v1→v2 custody batch migrator (#1537) — thin operator wrapper over
 * POST /api/vault/migrate-custody.
 *
 * Migrates existing `node-sealed` vault entries to `delegation-grant`
 * custody. The actual migration logic (enumeration, the canary, per-field
 * verification, abort-on-first-failure) lives server-side in
 * apps/kernel/src/lib/vault/migrate-custody.ts — this script only calls the
 * route and prints its report.
 *
 * ## Sequencing — read this before running against production
 *
 *   1. Owner envelopes need no action: they are written automatically on
 *      every v2 seal (#1521/#1534), so each migrated field gets one for free.
 *   2. Under Tier 1 (VAULT_OWNER_X_PUB + VAULT_OWNER_ED_PUB configured on the
 *      kernel), the owner agent (`imajin-cli vault serve`) MUST already be
 *      running before you pass --apply. The route's canary will catch a dead
 *      or absent agent and abort after touching at most one field, but a
 *      healthy agent still needs to be online to fulfil the grants this
 *      migration creates.
 *   3. Back up the owner key first: `imajin vault backup`. Once entries are
 *      Tier-1 sealed, losing the owner key loses the secrets — there is no
 *      other recoverable copy.
 *
 * Dry-run by default. Pass --apply to actually upgrade fields.
 *
 * Usage:
 *   node scripts/migrate-vault-custody.mjs                    # dry-run, all remaining v1 fields
 *   node scripts/migrate-vault-custody.mjs --limit=5           # dry-run, first 5 only
 *   node scripts/migrate-vault-custody.mjs --apply --limit=5   # migrate up to 5, for real
 *
 * ## Targeted mode (#2311)
 *
 * To migrate an exact, known set of fields instead of "the next N" — e.g. a
 * set a previous batch run missed — pass --fields, either inline or from a
 * file (one field name per line; blank lines and `#`-prefixed lines ignored):
 *
 *   node scripts/migrate-vault-custody.mjs --dry-run --fields=github-oauth:did:...,github-config:did:...
 *   node scripts/migrate-vault-custody.mjs --dry-run --fields=@./missed-fields.txt
 *   node scripts/migrate-vault-custody.mjs --apply --fields=@./missed-fields.txt
 *
 * --dry-run is the default and may also be passed explicitly for clarity; it
 * is an error to pass both --apply and --dry-run. A dry run with --fields
 * prints exactly the planned per-field action and each field's owner DID
 * (truncated to 20 chars) so an operator can confirm the set before
 * re-running with --apply — it never touches plaintext or key material, and
 * a name with no live v1 entry is reported separately rather than silently
 * dropped.
 *
 * Auth: POST /api/vault/migrate-custody is admin-only (requireAdmin — a
 * session cookie whose actingAs DID matches the kernel's NODE_DID). Supply a
 * valid admin session via KERNEL_ADMIN_COOKIE, the full Cookie header from a
 * logged-in admin browser session, e.g.:
 *
 *   KERNEL_ADMIN_COOKIE='imajin_session=...; x-acting-as=did:imajin:...' \
 *     node scripts/migrate-vault-custody.mjs --apply
 *
 * KERNEL_BASE_URL defaults to http://localhost:3000.
 */

import { readFile } from 'node:fs/promises';

const APPLY = process.argv.includes('--apply');
const DRY_RUN_FLAG = process.argv.includes('--dry-run');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
const fieldsArg = process.argv.find((arg) => arg.startsWith('--fields='));

// Strip CR/LF (and other control chars) before logging interpolated values, so
// HTTP-response-derived strings can't forge log lines (log injection, S5145).
function sanitizeForLog(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** Parse --fields=<comma list>|@<file path> into a de-duplicated field-name array. */
async function resolveFields(raw) {
  const text = raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw;
  const names = text
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !name.startsWith('#'));
  return [...new Set(names)];
}

let BASE = process.env.KERNEL_BASE_URL || 'http://localhost:3000';
while (BASE.endsWith('/')) BASE = BASE.slice(0, -1);

const COOKIE = process.env.KERNEL_ADMIN_COOKIE;

if (!COOKIE) {
  console.error('❌ KERNEL_ADMIN_COOKIE is required — set it to a logged-in admin session Cookie header.');
  process.exit(1);
}

if (APPLY && DRY_RUN_FLAG) {
  console.error('❌ --apply and --dry-run are mutually exclusive');
  process.exit(1);
}

if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('❌ --limit must be a positive integer');
  process.exit(1);
}

let fields;
if (fieldsArg) {
  fields = await resolveFields(fieldsArg.slice('--fields='.length));
  if (fields.length === 0) {
    console.error('❌ --fields resolved to an empty list');
    process.exit(1);
  }
}

async function postMigrationRequest() {
  const res = await fetch(`${BASE}/api/vault/migrate-custody`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: COOKIE,
    },
    body: JSON.stringify({
      dryRun: !APPLY,
      ...(limit !== undefined ? { limit } : {}),
      ...(fields !== undefined ? { fields } : {}),
    }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { res, json, text };
}

function formatFieldResult(r) {
  const ok = r.status === 'upgraded' || r.status === 'would-upgrade';
  const owner = r.ownerDidTruncated ? ` (owner: ${sanitizeForLog(r.ownerDidTruncated)})` : '';
  const suffix = r.error ? ` — ${sanitizeForLog(r.error)}` : '';
  return `  ${ok ? '✓' : '✗'} ${sanitizeForLog(r.field)}: ${sanitizeForLog(r.status)}${owner}${suffix}`;
}

function logFieldResults(results) {
  console.log(`\n--- per-field results ---`);
  if (results.length === 0) {
    console.log('  (none — nothing attempted)');
  }
  for (const r of results) {
    console.log(formatFieldResult(r));
  }
}

function logNotFound(notFound) {
  if (!notFound || notFound.length === 0) return;
  console.log(`\n--- requested but not in the live v1 set (already v2, deleted, or a typo) ---`);
  for (const field of notFound) {
    console.log(`  ? ${sanitizeForLog(field)}`);
  }
}

async function run() {
  console.log(`\n=== Vault custody migration (#1537 / #2311) ===`);
  console.log(`target: ${BASE}`);
  console.log(`mode: ${APPLY ? 'APPLY (will upgrade fields)' : 'DRY-RUN (no writes)'}`);
  if (limit !== undefined) console.log(`limit: ${limit}`);
  if (fields !== undefined) console.log(`fields: ${fields.length} explicitly targeted`);

  const { res, json, text } = await postMigrationRequest();

  if (!res.ok) {
    console.error(`\n❌ request failed: ${res.status}`);
    console.error(sanitizeForLog(json ? JSON.stringify(json) : text));
    process.exit(1);
  }

  const report = json;
  console.log(`\ntier1: ${sanitizeForLog(report.tier1)}`);
  console.log(`v1 fields remaining before this run: ${sanitizeForLog(report.totalV1Fields)}`);
  console.log(`candidates this run: ${sanitizeForLog(report.candidateCount)}`);

  logFieldResults(report.results);
  logNotFound(report.notFound);

  if (report.aborted) {
    console.error(`\n❌ ABORTED: ${sanitizeForLog(report.abortReason)}`);
    process.exit(1);
  }

  console.log(`\n✅ ${APPLY ? 'Migration' : 'Dry-run'} complete.`);
  if (!APPLY) {
    console.log('Re-run with --apply to commit.');
  }
}

try {
  await run();
} catch (err) {
  console.error('❌ FAILED:', err?.message ?? err);
  process.exit(1);
}
