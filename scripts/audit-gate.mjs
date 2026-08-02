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
 * not fail. Across 400 failed CI runs it never once failed on a finding —
 * every failure was `Install dependencies`.
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
 * ## Why this reads a file rather than running the audit itself
 *
 * An earlier revision shelled out to `pnpm`, which meant resolving the binary
 * through `PATH` — flagged by sonar S4036, and fairly: a writeable PATH entry
 * turns a CI gate into arbitrary code execution. Taking the report as input
 * removes the process spawn entirely and makes this a pure function of its
 * input, which is also far easier to reason about and to test.
 *
 * The caller produces the report:
 *
 *   pnpm audit --prod --audit-level high --json > audit-report.json || true
 *   node scripts/audit-gate.mjs audit-report.json
 *
 * Usage:
 *   node scripts/audit-gate.mjs [report.json]            # fail on new advisories
 *   node scripts/audit-gate.mjs [report.json] --report   # never fail; print status
 *   node scripts/audit-gate.mjs [report.json] --prune    # drop resolved baseline entries
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.github', 'audit-baseline.json');
const DEFAULT_REPORT = 'audit-report.json';

const args = process.argv.slice(2);
const REPORT_ONLY = args.includes('--report');
const PRUNE = args.includes('--prune');
const reportArg = args.find((a) => !a.startsWith('--')) ?? DEFAULT_REPORT;
const REPORT_PATH = resolve(ROOT, reportArg);

/**
 * Compare strings deterministically.
 *
 * Always passed explicitly: `Array.prototype.sort` with no comparator coerces
 * to string and sorts by UTF-16 code unit, which is a correctness trap the
 * moment the array stops holding strings.
 */
const byString = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/**
 * Decode a report buffer, honouring a byte-order mark.
 *
 * bash writes UTF-8, but PowerShell 5.1's `>` writes UTF-16LE. Assuming UTF-8
 * means the documented command works in CI and fails on a Windows dev box with
 * an unreadable parse error — a genuinely unpleasant way to meet a portability
 * bug. Decoding by BOM costs four lines and removes the trap.
 */
function decodeReport(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: node has no decoder, so byte-swap into LE first.
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return swapped.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * Read the `pnpm audit --json` report.
 *
 * Exits 2 rather than 1 on a malformed or missing report: that is a broken
 * pipeline, not a policy failure, and conflating the two is how a gate ends up
 * silently passing. `pnpm audit` exits non-zero whenever it reports anything,
 * so the caller is expected to tolerate that exit code — but it must still
 * produce parseable JSON, and this is where that is enforced.
 */
function readReport() {
  let buf;
  try {
    buf = readFileSync(REPORT_PATH);
  } catch {
    console.error(`audit-gate: cannot read audit report at ${REPORT_PATH}`);
    console.error('audit-gate: expected `pnpm audit --prod --audit-level high --json > <file>`');
    process.exit(2);
  }

  const raw = decodeReport(buf);

  if (!raw.trim()) {
    console.error(`audit-gate: audit report at ${REPORT_PATH} is empty`);
    process.exit(2);
  }

  try {
    return JSON.parse(raw);
  } catch {
    console.error(`audit-gate: could not parse audit report at ${REPORT_PATH}`);
    console.error(raw.slice(0, 2000));
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
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { note: '', created: null, issue: null, advisories: [] };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const report = readReport();
const found = collectFindings(report);
const baseline = loadBaseline();
const baselineIds = new Set((baseline.advisories ?? []).map((a) => a.id));

const introduced = [...found.values()].filter((a) => !baselineIds.has(a.id));
const resolvedIds = [...baselineIds].filter((id) => !found.has(id));

console.log(`audit-gate: ${found.size} high/critical advisories in prod deps`);
console.log(`            ${baselineIds.size} in baseline, ${introduced.length} new, ${resolvedIds.length} resolved`);

if (resolvedIds.length > 0) {
  const orderedResolved = [...resolvedIds].sort(byString);
  console.log('\nResolved since the baseline was taken — remove these from .github/audit-baseline.json:');
  for (const id of orderedResolved) console.log(`  - ${id}`);
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
  const ordered = [...introduced].sort((x, y) => byString(x.module, y.module));
  console.log('\nNEW high/critical advisories, not in the baseline:\n');
  for (const a of ordered) {
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
