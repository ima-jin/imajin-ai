#!/usr/bin/env node
/**
 * Dependency audit gate (#1559).
 *
 * ## Why this exists rather than a bare `pnpm audit`
 *
 * The CI step used to be:
 *
 *   pnpm audit --prod --audit-level high || echo "::warning::..."
 *
 * The `|| echo` swallowed the exit code, so a job named "Security Audit" could
 * not fail. Across 400 failed CI runs it never once failed on an actual
 * finding — every failure was `Install dependencies`.
 *
 * Deleting the `|| echo` is the obvious fix and it does not survive contact
 * with reality. `pnpm audit` fails on *any* qualifying advisory, including
 * ones published upstream overnight against code nobody touched. A gate that
 * red-lights unrelated PRs gets suppressed again within a month — which is
 * presumably how the `|| echo` got there in the first place.
 *
 * ## What this does instead: a ratchet
 *
 * Advisories present when the gate was introduced live in a committed
 * baseline. The gate fails only on advisories NOT in that baseline — i.e. ones
 * this change introduced, or ones newly published. Existing debt stays visible
 * in a reviewable file instead of being hidden behind a suppressed exit code.
 *
 * The baseline is a debt ledger, not an allowlist. Entries that no longer
 * appear are reported so it shrinks over time; that direction is one-way by
 * design.
 *
 * Usage:
 *   node scripts/audit-gate.mjs            # gate: fail on new advisories
 *   node scripts/audit-gate.mjs --report   # never fail; print status
 *   node scripts/audit-gate.mjs --prune    # rewrite baseline, dropping resolved
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.github', 'audit-baseline.json');

const REPORT_ONLY = process.argv.includes('--report');
const PRUNE = process.argv.includes('--prune');

/**
 * Run the audit and return parsed JSON.
 *
 * `pnpm audit` exits non-zero when it finds anything at or above the level,
 * which is the normal case here — the exit code is deliberately ignored and
 * the report is read instead. A genuinely broken invocation is detected by
 * unparseable output, not by the exit code.
 */
function runAudit() {
  const res = spawnSync(
    'pnpm',
    ['audit', '--prod', '--audit-level', 'high', '--json'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 },
  );

  if (!res.stdout || !res.stdout.trim()) {
    console.error('audit-gate: pnpm audit produced no output');
    console.error(res.stderr ?? '(no stderr)');
    process.exit(2);
  }

  try {
    return JSON.parse(res.stdout);
  } catch {
    console.error('audit-gate: could not parse pnpm audit JSON output');
    console.error(res.stdout.slice(0, 2000));
    process.exit(2);
  }
}

/** Prefer the GHSA id: stable, and what GitHub links to. Fall back to CVE. */
function advisoryId(advisory) {
  const refs = advisory.references ?? '';
  for (const line of refs.split('\n')) {
    if (line.includes('github.com/advisories/GHSA-')) {
      return line.slice(line.lastIndexOf('/') + 1).trim();
    }
  }
  return advisory.cves?.[0] ?? `npm-${advisory.id}`;
}

function collectFindings(report) {
  const found = new Map();
  for (const advisory of Object.values(report.advisories ?? {})) {
    if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;
    const id = advisoryId(advisory);
    if (!found.has(id)) {
      found.set(id, {
        id,
        module: advisory.module_name,
        severity: advisory.severity,
        title: advisory.title,
        patched: advisory.patched_versions ?? '',
      });
    }
  }
  return found;
}

function loadBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return parsed;
  } catch {
    return { note: '', created: null, issue: null, advisories: [] };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const report = runAudit();
const found = collectFindings(report);
const baseline = loadBaseline();
const baselineIds = new Set((baseline.advisories ?? []).map((a) => a.id));

const introduced = [...found.values()].filter((a) => !baselineIds.has(a.id));
const resolved = [...baselineIds].filter((id) => !found.has(id));

console.log(`audit-gate: ${found.size} high/critical advisories in prod deps`);
console.log(`            ${baselineIds.size} in baseline, ${introduced.length} new, ${resolved.length} resolved`);

if (resolved.length > 0) {
  console.log('\nResolved since the baseline was taken — remove these from .github/audit-baseline.json:');
  for (const id of resolved.sort()) console.log(`  - ${id}`);
}

if (PRUNE) {
  const next = {
    ...baseline,
    advisories: (baseline.advisories ?? []).filter((a) => found.has(a.id)),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`\naudit-gate: baseline pruned to ${next.advisories.length} entries`);
  process.exit(0);
}

if (introduced.length > 0) {
  console.log('\nNEW high/critical advisories, not in the baseline:\n');
  for (const a of introduced.sort((x, y) => x.module.localeCompare(y.module))) {
    const fix = a.patched && a.patched !== '<0.0.0' ? `upgrade to ${a.patched}` : 'no fix published';
    console.log(`  ${a.severity.toUpperCase()}  ${a.module}  ${a.id}`);
    console.log(`         ${a.title}`);
    console.log(`         ${fix}`);
  }
  console.log(
    '\nResolve by upgrading, or by adding a pnpm override. If the advisory genuinely\n' +
    'cannot be fixed, add it to .github/audit-baseline.json with a reason — that is a\n' +
    'reviewable decision, unlike suppressing the whole gate.',
  );
  if (!REPORT_ONLY) process.exit(1);
}

if (introduced.length === 0) {
  console.log('\naudit-gate: no new high/critical advisories.');
}
