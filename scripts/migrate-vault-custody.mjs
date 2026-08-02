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

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;

// Strip CR/LF (and other control chars) before logging interpolated values, so
// HTTP-response-derived strings can't forge log lines (log injection, S5145).
function sanitizeForLog(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

let BASE = process.env.KERNEL_BASE_URL || 'http://localhost:3000';
while (BASE.endsWith('/')) BASE = BASE.slice(0, -1);

const COOKIE = process.env.KERNEL_ADMIN_COOKIE;

if (!COOKIE) {
  console.error('❌ KERNEL_ADMIN_COOKIE is required — set it to a logged-in admin session Cookie header.');
  process.exit(1);
}

if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('❌ --limit must be a positive integer');
  process.exit(1);
}

async function run() {
  console.log(`\n=== Vault custody migration (#1537) ===`);
  console.log(`target: ${BASE}`);
  console.log(`mode: ${APPLY ? 'APPLY (will upgrade fields)' : 'DRY-RUN (no writes)'}`);
  if (limit !== undefined) console.log(`limit: ${limit}`);

  const res = await fetch(`${BASE}/api/vault/migrate-custody`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: COOKIE,
    },
    body: JSON.stringify({ dryRun: !APPLY, ...(limit !== undefined ? { limit } : {}) }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) {
    console.error(`\n❌ request failed: ${res.status}`);
    console.error(sanitizeForLog(json ? JSON.stringify(json) : text));
    process.exit(1);
  }

  const report = json;
  console.log(`\ntier1: ${sanitizeForLog(report.tier1)}`);
  console.log(`v1 fields remaining before this run: ${sanitizeForLog(report.totalV1Fields)}`);
  console.log(`candidates this run: ${sanitizeForLog(report.candidateCount)}`);

  console.log(`\n--- per-field results ---`);
  if (report.results.length === 0) {
    console.log('  (none — nothing attempted)');
  }
  for (const r of report.results) {
    const ok = r.status === 'upgraded' || r.status === 'would-upgrade';
    const suffix = r.error ? ` — ${sanitizeForLog(r.error)}` : '';
    console.log(`  ${ok ? '✓' : '✗'} ${sanitizeForLog(r.field)}: ${sanitizeForLog(r.status)}${suffix}`);
  }

  if (report.aborted) {
    console.error(`\n❌ ABORTED: ${sanitizeForLog(report.abortReason)}`);
    process.exit(1);
  }

  console.log(`\n✅ ${APPLY ? 'Migration' : 'Dry-run'} complete.`);
  if (!APPLY) {
    console.log('Re-run with --apply to commit.');
  }
}

run().catch((err) => {
  console.error('❌ FAILED:', err?.message ?? err);
  process.exit(1);
});
