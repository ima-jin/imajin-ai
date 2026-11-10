import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  audiences, checkCapabilities, readCapabilities, renderCapabilityTables, validateCapabilities,
} from '../check-capabilities.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const document = readCapabilities(resolve(root, 'docs/capabilities/capabilities.yaml'));
const readme = readFileSync(resolve(root, 'docs/capabilities/README.md'), 'utf8').replaceAll('\r\n', '\n');
const validateMutation = mutate => {
  const copy = structuredClone(document);
  mutate(copy, copy.capabilities[0]);
  return validateCapabilities(copy, root);
};

describe('capability map acceptance', () => {
  it('validates every app, package, local spec and evidence path in the real map', () => {
    expect(checkCapabilities(root)).toEqual([]);
  });

  it('runs as a standalone command', () => {
    const result = spawnSync(process.execPath, ['scripts/check-capabilities.mjs'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('coverage valid');
  });

  it('keeps the audience-grouped readable table exactly aligned with YAML', () => {
    expect(readme).toContain(renderCapabilityTables(document));
    for (const audience of audiences) expect(readme).toContain(`<summary>${audience} (`);
    for (const capability of document.capabilities) expect(readme).toContain(`\`${capability.id}\``);
  });

  it('provides rubric, six audience jobs, navigation, positioning and every core partial gap', () => {
    for (const heading of ['Grading rubric', 'Per-audience main jobs', 'Navigation proposal', 'Positioning cut for #3284', 'Gaps']) {
      expect(readme).toContain(heading);
    }
    const navigation = readme.split('## Navigation proposal')[1].split('<details>')[0];
    expect(navigation.match(/^\d\. \*\*/gm)).toHaveLength(6);
    for (const capability of document.capabilities.filter(row => row.business_weight === 'core' && ['partial', 'dormant'].includes(row.maturity))) {
      expect(readme.split('## Gaps')[1]).toContain(`\`${capability.id}\``);
    }
    expect(readme).toContain('the trust layer for AI agents');
    expect(readme).toContain('platforms and agencies');
    expect(readme).toContain('book a demo');
    expect(readme).toContain('Alpha');
  });

  it('is discovered by Vitest and executed by the existing required CI test job', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8');
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
    expect(config).toContain("'scripts/__tests__/**/*.test.mjs'");
    expect(workflow.jobs['test-shards'].steps.some(step => step.run?.includes('test:agent --coverage'))).toBe(true);
  });

  it('keeps the validator read-only and independent of product runtime and identity context', () => {
    const script = readFileSync(resolve(root, 'scripts/check-capabilities.mjs'), 'utf8');
    expect(script).not.toMatch(/writeFile|unlink|rmSync|from ['"](?:@imajin|.*apps\/)/);
    expect(script).not.toMatch(/fetch\(|process\.env/);
  });
});

describe('schema rejection rules', () => {
  it.each(['schema_version', 'as_of', 'source_commit', 'capabilities'])('rejects missing root %s', field => {
    expect(validateMutation(copy => Reflect.deleteProperty(copy, field))).not.toEqual([]);
  });

  it.each(['id', 'name', 'action', 'apps', 'services', 'packages', 'entry_points', 'audience', 'maturity', 'business_weight', 'pillars', 'grade_reason', 'evidence'])('rejects missing capability %s', field => {
    expect(validateMutation((_copy, row) => Reflect.deleteProperty(row, field))).not.toEqual([]);
  });

  it.each(['ui', 'api', 'sdk', 'specs'])('rejects missing entry field %s', field => {
    expect(validateMutation((_copy, row) => Reflect.deleteProperty(row.entry_points, field))).not.toEqual([]);
  });

  it.each(['code', 'tests', 'navigation', 'last_touched', 'open_issues'])('rejects missing evidence field %s', field => {
    expect(validateMutation((_copy, row) => Reflect.deleteProperty(row.evidence, field))).not.toEqual([]);
  });

  it.each(['audience', 'maturity', 'business_weight'])('rejects unknown %s enum', field => {
    expect(validateMutation((_copy, row) => { row[field] = 'invented'; })).not.toEqual([]);
  });

  it.each([
    ['unsupported schema', copy => { copy.schema_version = 2; }],
    ['empty map', copy => { copy.capabilities = []; }],
    ['nonarray map', copy => { copy.capabilities = {}; }],
    ['invalid snapshot', copy => { copy.as_of = '2026-02-30'; }],
    ['invalid source SHA', copy => { copy.source_commit = 'main'; }],
    ['null root', copy => { copy.capabilities.push(null); }],
    ['duplicate id', copy => { copy.capabilities.push(structuredClone(copy.capabilities[0])); }],
    ['invalid id', (_copy, row) => { row.id = 'Has spaces'; }],
    ['empty text', (_copy, row) => { row.action = ' '; }],
    ['unknown pillar', (_copy, row) => { row.pillars = ['new pillar']; }],
    ['mixed none', (_copy, row) => { row.pillars = ['none', 'agent identity']; }],
    ['core without pillar', (_copy, row) => { row.pillars = ['none']; }],
    ['empty pillars', (_copy, row) => { row.pillars = []; }],
    ['malformed pillars', (_copy, row) => { row.pillars = {}; }],
    ['malformed entries', (_copy, row) => { row.entry_points = null; }],
    ['malformed evidence', (_copy, row) => { row.evidence = null; }],
    ['malformed spec array', (_copy, row) => { row.entry_points.specs = {}; }],
    ['empty service', (_copy, row) => { row.services = []; }],
    ['nonarray packages', (_copy, row) => { row.packages = 'auth'; }],
    ['empty code', (_copy, row) => { row.evidence.code = []; }],
    ['no tests for works', (_copy, row) => { row.maturity = 'works'; row.evidence.tests = []; }],
    ['no UI for live', (_copy, row) => { row.maturity = 'live'; row.entry_points.ui = []; }],
    ['no API for live', (_copy, row) => { row.maturity = 'live'; row.entry_points.api = []; }],
    ['no nav for live', (_copy, row) => { row.maturity = 'live'; row.evidence.navigation = []; }],
    ['invalid touched date', (_copy, row) => { row.evidence.last_touched = 'tomorrow'; }],
    ['out-of-org issue', (_copy, row) => { row.evidence.open_issues = ['https://github.com/elsewhere/repo/issues/1']; }],
    ['unknown app', (_copy, row) => { row.apps = ['missing-app']; }],
    ['unknown package', (_copy, row) => { row.packages = ['missing-package']; }],
    ['uncovered app', copy => { copy.capabilities = copy.capabilities.filter(row => !row.apps.includes('corpus')); }],
    ['uncovered package', copy => { for (const row of copy.capabilities) row.packages = []; }],
    ['uncovered spec', copy => { for (const row of copy.capabilities) row.entry_points.specs = []; }],
  ])('rejects %s', (_label, mutation) => {
    expect(validateMutation(mutation)).not.toEqual([]);
  });

  it.each(['evidence.code', 'evidence.tests', 'evidence.navigation', 'entry_points.specs'])('rejects nonexistent %s paths', field => {
    expect(validateMutation((_copy, row) => {
      const [parent, child] = field.split('.');
      row[parent][child] = ['apps/not-a-real-file.ts'];
    })).not.toEqual([]);
  });

  it.each(['../outside.ts', '/etc/passwd', 'C:\\outside.ts', 'apps', '', 42])('rejects unsafe or non-file evidence %s', value => {
    expect(validateMutation((_copy, row) => { row.evidence.code = [value]; })).not.toEqual([]);
  });

  it.each(['id: one\nid: two\n', 'capabilities: ['])('rejects duplicate keys and malformed YAML', yaml => {
    const directory = mkdtempSync(resolve(tmpdir(), 'capability-yaml-'));
    const file = resolve(directory, 'invalid.yaml');
    try {
      writeFileSync(file, yaml);
      expect(() => readCapabilities(file)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
