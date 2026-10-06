/**
 * Guard for tag-release.yml's version parsing + manual-dispatch wiring (#2622).
 *
 * v0.8.14 was merged with the first line
 * `release: v0.8.14 (re-stamp after main merge into release branch)`; the old
 * `${FIRST_LINE#release: v}` + anchored `^X.Y.Z$` check rejected it, so no tag
 * was created and deploy-prod was never dispatched.
 *
 *  1. scripts/lib/parse-release-version.sh (sourced by the workflow) yields the
 *     bare version for both `release: vX.Y.Z` and `release: vX.Y.Z <suffix>`,
 *     and still fails for malformed versions.
 *  2. tag-release.yml keeps its push-to-main trigger, adds a workflow_dispatch
 *     trigger with a required `sha` input, and really uses the shared parser.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const PARSER = fileURLToPath(new URL('../lib/parse-release-version.sh', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/tag-release.yml', import.meta.url));

function parse(firstLine) {
  const result = spawnSync(
    '/bin/bash',
    ['-c', 'source "$1" && parse_release_version "$2"', 'bash', PARSER, firstLine],
    { encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout.trim() };
}

describe('parse_release_version (#2622)', () => {
  it.each([
    ['release: v0.8.14', '0.8.14'],
    ['release: v0.8.14 (re-stamp after main merge into release branch)', '0.8.14'],
    ['release: v0.8.14 anything', '0.8.14'],
    ['release: v10.20.30\t(tab suffix)', '10.20.30'],
  ])('accepts %j -> %s', (line, version) => {
    expect(parse(line)).toEqual({ status: 0, stdout: version });
  });

  it.each([
    'release: vfoo',
    'release: v',
    'release: v0.8',
    'release: v0.8.14.1',
    'release: v0.8.14-rc1',
    'release: v0.8.14(no space)',
    'release: 0.8.14',
    'chore: release: v0.8.14',
    'Merge pull request #2609 from ima-jin/release/v0.8.14',
    '',
  ])('rejects %j', (line) => {
    expect(parse(line)).toEqual({ status: 1, stdout: '' });
  });
});

describe('tag-release.yml wiring (#2622)', () => {
  const raw = readFileSync(WORKFLOW, 'utf8');
  const workflow = YAML.parse(raw);
  // `on` is parsed as the boolean key `true` by YAML 1.1 parsers; accept either.
  const triggers = workflow.on ?? workflow[true];

  it('keeps the push-to-main trigger unchanged', () => {
    expect(triggers.push).toEqual({ branches: ['main'] });
  });

  it('adds a workflow_dispatch trigger with a required sha input', () => {
    expect(triggers.workflow_dispatch.inputs.sha).toMatchObject({ required: true, type: 'string' });
  });

  it('parses the version through the shared parser', () => {
    expect(raw).toContain('scripts/lib/parse-release-version.sh');
    expect(raw).toContain('parse_release_version');
    expect(raw).not.toContain('${FIRST_LINE#release: v}');
  });

  it('never interpolates the dispatch input directly into a shell script', () => {
    for (const step of workflow.jobs['tag-and-deploy'].steps) {
      expect(step.run ?? '').not.toContain('${{ inputs.sha }}');
      expect(step.run ?? '').not.toContain('github.event.inputs');
    }
  });
});
