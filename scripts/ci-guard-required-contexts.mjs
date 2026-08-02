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
 * it.
 *
 * This happened in #1561: the ruleset required `Lint & Typecheck`, but the job
 * had been renamed to `Lint`. The old context waited forever; the new context
 * was not required, so lint became advisory without anyone deciding that.
 *
 * Renaming a CI job is a breaking change to branch protection, and GitHub
 * gives no warning. This guard automates the check so the breakage is caught
 * in CI, not discovered by accident months later.
 *
 * ## What it does
 *
 * 1. Fetches the active "Branch Protection" ruleset for this repo via the
 *    GitHub API, resolving the ruleset id dynamically.
 * 2. Extracts every `required_status_checks[].context` from that ruleset.
 * 3. Parses every `.github/workflows/*.yml` and collects the `name:` of every
 *    job (falling back to the job-id when `name:` is absent).
 * 4. Fails if any required context is not present in the set of job names.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036). All data comes from files or an HTTPS API call.
 * - The API call uses the `gh` CLI, which is already authenticated in CI and
 *   in local dev; if unavailable we fail-soft with a clear message.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : join(fileURLToPath(import.meta.url), '..', '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
const REPO = 'ima-jin/imajin-ai';

/**
 * Compare strings deterministically.
 */
const byString = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/**
 * Fetch the active Branch Protection ruleset id and its required contexts.
 *
 * Uses `gh api` because it handles auth (GITHUB_TOKEN in CI, local creds
 * elsewhere). If `gh` is unavailable or unauthenticated, we print a clear
 * skip message and exit 0 — the guard cannot make a decision without data,
 * but we do not want to block CI on a missing token in a fork.
 */
async function fetchRequiredContexts() {
  let rulesetsJson;
  try {
    const { execSync } = await import('node:child_process');
    rulesetsJson = execSync(
      `gh api repos/${REPO}/rulesets --jq '.[] | select(.name == "Branch Protection" and .enforcement == "active") | .id'`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
  } catch {
    console.log(
      'ci-guard-required-contexts: SKIP — cannot reach GitHub API (gh CLI unavailable or unauthenticated)',
    );
    console.log(
      '  This is expected in forks without GITHUB_TOKEN. The guard will run in the upstream repo.',
    );
    process.exit(0);
  }

  if (!rulesetsJson) {
    console.error('ci-guard-required-contexts: no active Branch Protection ruleset found');
    process.exit(1);
  }

  const rulesetId = rulesetsJson;

  let rulesetJson;
  try {
    const { execSync } = await import('node:child_process');
    rulesetJson = execSync(`gh api repos/${REPO}/rulesets/${rulesetId}`, {
      encoding: 'utf8',
      timeout: 15000,
    }).trim();
  } catch {
    console.error(`ci-guard-required-contexts: failed to fetch ruleset ${rulesetId}`);
    process.exit(1);
  }

  let ruleset;
  try {
    ruleset = JSON.parse(rulesetJson);
  } catch {
    console.error('ci-guard-required-contexts: ruleset response was not valid JSON');
    process.exit(1);
  }

  const requiredStatusChecksRule = (ruleset.rules ?? []).find(
    (r) => r.type === 'required_status_checks',
  );
  const contexts =
    requiredStatusChecksRule?.parameters?.required_status_checks?.map((c) => c.context) ?? [];

  return contexts;
}

/**
 * Collect every job name (or job-id fallback) from all workflow files.
 */
function collectJobNames() {
  const names = new Set();

  let files;
  try {
    files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch {
    console.error(`ci-guard-required-contexts: cannot read ${WORKFLOWS_DIR}`);
    process.exit(1);
  }

  for (const file of files) {
    const path = join(WORKFLOWS_DIR, file);
    let doc;
    try {
      doc = YAML.parse(readFileSync(path, 'utf8'));
    } catch {
      console.error(`ci-guard-required-contexts: cannot parse ${path}`);
      process.exit(1);
    }

    const jobs = doc?.jobs;
    if (!jobs || typeof jobs !== 'object') continue;

    for (const [jobId, jobDef] of Object.entries(jobs)) {
      const name = typeof jobDef?.name === 'string' ? jobDef.name : jobId;
      names.add(name);
    }
  }

  return names;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const requiredContexts = await fetchRequiredContexts();
const jobNames = collectJobNames();

console.log(`ci-guard-required-contexts: ${requiredContexts.length} required context(s)`);
console.log(`ci-guard-required-contexts: ${jobNames.size} job name(s) found in workflows`);

const orphaned = requiredContexts.filter((ctx) => !jobNames.has(ctx)).sort(byString);

if (orphaned.length > 0) {
  console.error('\nFAIL: required context(s) with no producing job:\n');
  for (const ctx of orphaned) {
    console.error(`  - "${ctx}"`);
  }
  console.error(
    '\nEach required context must match a job `name:` (or job-id if unnamed) in .github/workflows/*.yml.',
  );
  console.error('Renaming a job is a breaking change to branch protection.');
  process.exit(1);
}

console.log('\nPASS: every required context is emitted by a job.');
process.exit(0);
