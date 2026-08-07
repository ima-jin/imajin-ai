#!/usr/bin/env node
/**
 * Required-context producer guard (#1559).
 *
 * ## Why this exists
 *
 * Branch protection on `main` requires a set of status-check contexts. A job
 * posts a context under its `name:` (or its job-id if unnamed). If a required
 * context has no job that emits it, the check sits at "Expected — waiting for
 * status" forever. That blocks merge through the front door, while the bypass
 * silently lets PRs through, so nobody experiences the block and nobody fixes
 * it. This happened in #1561: the ruleset required `Lint & Typecheck`, but the
 * job had been renamed to `Lint`.
 *
 * ## Why it was rewritten
 *
 * The first version read the live ruleset through `gh api` and exited 0 when
 * that call failed. In the upstream repo's own CI it printed
 *
 *   ci-guard-required-contexts: SKIP — cannot reach GitHub API
 *
 * on every single run: the runner container has no `gh`, and reading rulesets
 * needs an admin-scoped token that `secrets.GITHUB_TOKEN` is not. So a guard
 * written to catch checks that cannot fail was itself a check that could not
 * fail — inside a REQUIRED context. That is the #1559 pattern exactly.
 *
 * The fix is to stop depending on privileged access for the part that matters.
 * `.github/required-checks.json` declares intent in-repo, so the producer check
 * runs offline and can genuinely fail. The live ruleset is then only used to
 * detect drift between declared intent and actual GitHub config.
 *
 * ## What it does
 *
 * Always (no network, hard-fails):
 *   1. Every context in `required` is emitted by some job `name:`.
 *   2. `required` and `advisory` do not overlap, and neither has duplicates.
 *
 * Additionally, when an admin-scoped token is available (hard-fails on drift):
 *   3. The live ruleset's required contexts match `required` exactly.
 *
 * Step 3 degrades to a loud warning when the API is unreachable or the token
 * lacks permission. That half is advisory BY DESIGN and says so on every run —
 * it is not allowed to be silent again.
 *
 * Set `CI_GUARD_REQUIRE_RULESET=1` to make an unavailable ruleset a hard error
 * (use once an admin-scoped token is provisioned in CI).
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036): the ruleset is fetched with global `fetch`, not the
 *   `gh` CLI, which also removes the dependency that made this a no-op.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : join(fileURLToPath(import.meta.url), '..', '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
const MANIFEST_PATH = join(ROOT, '.github', 'required-checks.json');
const REPO = process.env.CI_GUARD_REPO ?? 'ima-jin/imajin-ai';
const RULESET_NAME = 'Branch Protection';

/** Compare strings deterministically. */
const byString = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

function fail(message, details = []) {
  console.error(`\nFAIL: ${message}\n`);
  for (const d of details) console.error(`  ${d}`);
  process.exit(1);
}

/** Load and validate the in-repo declaration of intent. */
function loadManifest() {
  let raw;
  try {
    raw = readFileSync(MANIFEST_PATH, 'utf8');
  } catch {
    fail(`cannot read ${MANIFEST_PATH}`, [
      'This file declares which checks are meant to block merge.',
      'Without it the guard cannot tell intent from accident.',
    ]);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    fail(`${MANIFEST_PATH} is not valid JSON`);
  }

  const required = manifest.required ?? [];
  const advisory = (manifest.advisory ?? []).map((a) => a.context);

  if (!Array.isArray(manifest.required) || required.length === 0) {
    fail('required-checks.json must list at least one required context');
  }

  const dupes = required.filter((c, i) => required.indexOf(c) !== i);
  if (dupes.length > 0) {
    fail('duplicate entries in `required`', [...new Set(dupes)].sort(byString));
  }

  const overlap = required.filter((c) => advisory.includes(c));
  if (overlap.length > 0) {
    fail('context listed as BOTH required and advisory', overlap.sort(byString));
  }

  return { required, advisory };
}

/** Collect every job name (or job-id fallback) from all workflow files. */
function collectJobNames() {
  const names = new Set();

  let files;
  try {
    files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch {
    fail(`cannot read ${WORKFLOWS_DIR}`);
  }

  for (const file of files) {
    const path = join(WORKFLOWS_DIR, file);
    let doc;
    try {
      doc = YAML.parse(readFileSync(path, 'utf8'));
    } catch {
      fail(`cannot parse ${path}`);
    }

    const jobs = doc?.jobs;
    if (!jobs || typeof jobs !== 'object') continue;

    for (const [jobId, jobDef] of Object.entries(jobs)) {
      names.add(typeof jobDef?.name === 'string' ? jobDef.name : jobId);
    }
  }

  return names;
}

/**
 * Read the live ruleset's required contexts.
 *
 * Returns `{ ok: true, contexts }`, or `{ ok: false, reason }` when the caller
 * should degrade. Never throws and never silently returns success.
 */
async function fetchLiveContexts() {
  const token = process.env.RULESET_READ_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    return { ok: false, reason: 'no RULESET_READ_TOKEN / GITHUB_TOKEN in the environment' };
  }

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'ci-guard-required-contexts',
  };

  let listRes;
  try {
    listRes = await fetch(`https://api.github.com/repos/${REPO}/rulesets`, { headers });
  } catch (err) {
    return { ok: false, reason: `network error: ${String(err)}` };
  }
  if (!listRes.ok) {
    return {
      ok: false,
      reason: `GET /rulesets returned ${listRes.status} (reading rulesets needs an admin-scoped token)`,
    };
  }

  const rulesets = await listRes.json();
  const match = rulesets.find((r) => r.name === RULESET_NAME && r.enforcement === 'active');
  if (!match) return { ok: false, reason: `no active ruleset named "${RULESET_NAME}"` };

  const detailRes = await fetch(`https://api.github.com/repos/${REPO}/rulesets/${match.id}`, {
    headers,
  });
  if (!detailRes.ok) {
    return { ok: false, reason: `GET /rulesets/${match.id} returned ${detailRes.status}` };
  }

  const ruleset = await detailRes.json();
  const rule = (ruleset.rules ?? []).find((r) => r.type === 'required_status_checks');
  const contexts = rule?.parameters?.required_status_checks?.map((c) => c.context) ?? [];
  return { ok: true, contexts };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const { required, advisory } = loadManifest();
const jobNames = collectJobNames();

console.log(`ci-guard-required-contexts: ${required.length} declared required context(s)`);
console.log(`ci-guard-required-contexts: ${jobNames.size} job name(s) found in workflows`);

// 1. Producer check — the part that must work without any API access.
const orphaned = required.filter((ctx) => !jobNames.has(ctx)).sort(byString);
if (orphaned.length > 0) {
  fail('required context(s) with no producing job:', [
    ...orphaned.map((c) => `- "${c}"`),
    '',
    'Each required context must match a job `name:` (or job-id if unnamed)',
    'in .github/workflows/*.yml. Renaming a job is a breaking change to',
    'branch protection — update .github/required-checks.json and the ruleset.',
  ]);
}

// Advisory entries are documentation, so a stale one is still misleading.
const staleAdvisory = advisory.filter((ctx) => !jobNames.has(ctx)).sort(byString);
if (staleAdvisory.length > 0) {
  fail('advisory context(s) with no producing job:', [
    ...staleAdvisory.map((c) => `- "${c}"`),
    '',
    'Remove them from .github/required-checks.json, or fix the job name.',
  ]);
}

// 2. Drift check — best-effort, but never silent.
const live = await fetchLiveContexts();

if (!live.ok) {
  const message = `ruleset drift check skipped — ${live.reason}`;
  if (process.env.CI_GUARD_REQUIRE_RULESET === '1') {
    fail(message, ['CI_GUARD_REQUIRE_RULESET=1 makes this a hard error.']);
  }
  console.log(`::warning::ci-guard-required-contexts: ${message}`);
  console.log(
    'Producer checks PASSED. Drift against the live ruleset was NOT verified — ' +
      'set RULESET_READ_TOKEN to an admin-scoped token to enable it.',
  );
  process.exit(0);
}

const declared = [...required].sort(byString);
const actual = [...live.contexts].sort(byString);
const missingFromRuleset = declared.filter((c) => !actual.includes(c));
const missingFromManifest = actual.filter((c) => !declared.includes(c));

if (missingFromRuleset.length > 0 || missingFromManifest.length > 0) {
  fail('declared required checks do not match the live ruleset:', [
    ...missingFromRuleset.map((c) => `- declared but NOT required on ${RULESET_NAME}: "${c}"`),
    ...missingFromManifest.map((c) => `- required on ${RULESET_NAME} but not declared: "${c}"`),
    '',
    'Update .github/required-checks.json or the ruleset so the two agree.',
  ]);
}

console.log(
  `\nPASS: ${declared.length} required context(s) produced and matching the live ruleset.`,
);
process.exit(0);
