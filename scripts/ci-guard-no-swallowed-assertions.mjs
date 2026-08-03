#!/usr/bin/env node
/**
 * Swallowed-assertion guard (#1559).
 *
 * ## Why this exists
 *
 * A CI step whose name implies an assertion (audit, test, lint, typecheck,
 * check, verify, scan, conformance, build) must actually be able to fail the
 * run. Three different bugs in this repo show what happens when it cannot:
 *
 * - #1539 — SonarCloud scanned with no coverage report, so new_coverage=0.0
 *   and the quality gate failed every PR that added code. The job itself had
 *   no failure history because the external check is what turns red.
 * - Security Audit (ci.yml) — `pnpm audit ... || echo "::warning::..."` swallowed
 *   the exit code. Across 400 failed runs the audit step never once failed;
 *   every failure was `Install dependencies`.
 * - imajin-cli tests — `continue-on-error: true` on the only test step meant
 *   the repo had no effective CI at all.
 *
 * The common pattern is a step whose NAME promises a guarantee while its
 * implementation neutralises the exit code. This guard scans workflow files
 * for that pattern and fails when found.
 *
 * ## What it checks
 *
 * For every step in `.github/workflows/*.yml` whose name matches an assertion
 * keyword (audit|test|lint|typecheck|check|verify|scan|conformance|build,
 * case-insensitive), the guard looks for:
 *   - `|| true`
 *   - `|| echo`
 *   - `continue-on-error: true`
 *
 * Any match is a failure, reported with file:line and the offending pattern.
 *
 * ## Allowlist
 *
 * Legitimate uses exist: `pnpm audit ... || true` where a SEPARATE gate step
 * decides (the current correct design in ci.yml). A line or step carrying the
 * inline marker `# ci-guard: allow <reason>` is exempted. The reason is
 * required — an unexplained exemption is as bad as an accidental suppression.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036). All data comes from YAML files.
 * - Parsing is done with the `yaml` package, already a root devDependency.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : join(fileURLToPath(import.meta.url), '..', '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

const ASSERTION_KEYWORDS =
  /\b(audit|tests?|lint|typecheck|check|verify|scan|conformance|build)\b/i;

const SWALLOW_PATTERNS = [
  { regex: /\|\|\s*true\b/, label: '|| true' },
  { regex: /\|\|\s*echo\b/, label: '|| echo' },
];

const ALLOW_MARKER = /#\s*ci-guard:\s*allow\s+(.+)/i;

/**
 * Determine whether a step is assertion-like by its name.
 */
function isAssertionStep(step) {
  const name = step?.name ?? '';
  return ASSERTION_KEYWORDS.test(name);
}

/**
 * Check a single step for swallow patterns.
 *
 * Returns an array of violation objects, or empty if clean.
 */
function checkStep(file, step, rawLines, stepStartLine) {
  const violations = [];
  const name = step?.name ?? '';

  // continue-on-error at the step level
  if (step?.['continue-on-error'] === true) {
    const line = findKeyLine(rawLines, stepStartLine, 'continue-on-error');
    violations.push({ file, line, step: name, pattern: 'continue-on-error: true' });
  }

  // || true / || echo in the run script
  const run = step?.run ?? '';
  const runLines = run.split('\n');
  for (let i = 0; i < runLines.length; i += 1) {
    const lineText = runLines[i];

    // Allowlist: any line with the marker is exempted
    const allowMatch = ALLOW_MARKER.exec(lineText);
    if (allowMatch) {
      continue;
    }

    for (const { regex, label } of SWALLOW_PATTERNS) {
      if (regex.test(lineText)) {
        // Map run-script line back to file line approximately
        const line = stepStartLine + i + 1;
        violations.push({ file, line, step: name, pattern: label });
      }
    }
  }

  return violations;
}

/**
 * Find the line number of a key inside a step block, approximately.
 * We scan rawLines starting from stepStartLine for the first occurrence
 * of the key. This is best-effort; YAML anchors/aliases can shift things.
 */
function findKeyLine(rawLines, stepStartLine, key) {
  for (let i = stepStartLine; i < rawLines.length; i += 1) {
    if (rawLines[i].includes(key)) return i + 1;
  }
  return stepStartLine + 1;
}

/**
 * Map a YAML node to its starting line number using the YAML CST.
 *
 * YAML.parseDocument keeps source positions on every node via .range[0],
 * which is the character offset. We convert that to a line number by
 * scanning the raw text.
 */
function offsetToLine(rawText, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < rawText.length; i += 1) {
    if (rawText[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Recursively find all "step" maps in a workflow document and record their
 * approximate starting line numbers.
 */
function* walkSteps(doc, rawText) {
  const jobs = doc.get('jobs');
  if (!jobs || typeof jobs !== 'object') return;

  for (const job of jobs.items ?? []) {
    const jobValue = job.value;
    if (!jobValue || typeof jobValue !== 'object') continue;

    const steps = jobValue.get('steps');
    if (!steps || !Array.isArray(steps.items)) continue;

    for (const step of steps.items) {
      const line = step?.range?.[0] != null ? offsetToLine(rawText, step.range[0]) : 1;
      yield { step: step.toJS(doc), line };
    }
  }
}

/**
 * Scan all workflow files for swallowed assertions.
 */
function scanWorkflows() {
  const violations = [];

  let files;
  try {
    files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch {
    console.error(`ci-guard-no-swallowed-assertions: cannot read ${WORKFLOWS_DIR}`);
    process.exit(1);
  }

  for (const file of files) {
    const path = join(WORKFLOWS_DIR, file);
    const raw = readFileSync(path, 'utf8');
    const rawLines = raw.split('\n');

    let doc;
    try {
      doc = YAML.parseDocument(raw);
    } catch {
      console.error(`ci-guard-no-swallowed-assertions: cannot parse ${path}`);
      process.exit(1);
    }

    for (const { step, line } of walkSteps(doc, raw)) {
      if (!isAssertionStep(step)) continue;
      const v = checkStep(file, step, rawLines, line - 1);
      violations.push(...v);
    }
  }

  return violations;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const violations = scanWorkflows();

if (violations.length > 0) {
  console.error(`\nFAIL: ${violations.length} swallowed assertion(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  step "${v.step}"  →  ${v.pattern}`);
  }
  console.error(
    '\nAssertion steps must be able to fail the run. If a swallow is intentional,',
  );
  console.error('add "# ci-guard: allow <reason>" on the same line.');
  process.exit(1);
}

console.log('PASS: no swallowed assertions found in workflow steps.');
process.exit(0);
