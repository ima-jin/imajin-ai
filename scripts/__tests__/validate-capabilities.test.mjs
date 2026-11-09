import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  AUDIENCES, GUIDE_PATH, MAP_PATH, ROOT, evidenceFile, parseMap,
  renderTable, validateGuide, validateMap, validateRepository,
} from '../validate-capabilities.mjs';

const content = readFileSync(join(ROOT, MAP_PATH), 'utf8');
const document = parseMap(content);
const guide = readFileSync(join(ROOT, GUIDE_PATH), 'utf8').replaceAll('\r\n', '\n');
const scratch = mkdtempSync(join(tmpdir(), 'capability-schema-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const copy = () => structuredClone(document);
const first = doc => doc.capabilities[0];
const live = doc => doc.capabilities.find(c => c.maturity.value === 'live');
const BROKER = 'broker-agent';
const SCRIPT = 'scripts/validate-capabilities.mjs';
const REQUIRED_FIELDS = 'required/unknown fields';
const EXPECTED_ARRAY = 'expected array';
const withoutBroker = app => app !== BROKER;

function reject(change, message) {
  const doc = copy();
  change(doc);
  expect(() => validateMap(doc)).toThrow(message);
}

describe('capability map acceptance', () => {
  it('validates real YAML, grades, evidence files and complete app/page/spec/package coverage', () => {
    expect(validateRepository().capabilities).toHaveLength(77);
    expect(new Set(document.capabilities.flatMap(c => c.apps)))
      .toEqual(new Set(['kernel', 'corpus', BROKER]));
  });

  it('includes every audience and a synchronized table of actions, not one row per route', () => {
    expect(new Set(document.capabilities.map(c => c.audience.value))).toEqual(new Set(AUDIENCES));
    expect(document.coverage.pages.length).toBeGreaterThan(document.capabilities.length);
    expect(() => validateGuide(guide, document)).not.toThrow();
    for (const audience of AUDIENCES) expect(guide).toContain(`**${audience}:**`);
  });

  it('has 4–7 proposed navigation groups and lists every partial/dormant core action as a gap', () => {
    const navigation = guide.split('## Primary navigation proposal')[1].split('## Positioning cut')[0];
    const count = [...navigation.matchAll(/^\d\. \*\*/gm)].length;
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(7);
    const gaps = guide.split('## Gaps and limitations')[1];
    for (const c of document.capabilities.filter(c =>
      c.business_weight.value === 'core' && ['partial', 'dormant'].includes(c.maturity.value))) {
      expect(gaps).toContain(`\`${c.id}\``);
    }
  });

  it('keeps Jin approvals with org admins and cites both personal and organization identity tests', () => {
    expect(document.capabilities.find(c => c.id === 'approve-actions').audience.value).toBe('org admin');
    const identityTests = document.capabilities.flatMap(c => c.evidence.tests);
    expect(identityTests).toContain('packages/auth/tests/acting-did.test.ts');
    expect(identityTests).toContain('apps/kernel/app/jin/api/events/__tests__/org-record.integration.test.ts');
    expect(identityTests).toContain('apps/kernel/src/lib/inference/__tests__/org-held-inference.integration.test.ts');
    expect(guide).toContain('not a reference-customer');
  });

  it('spot-checks five independent implementation citations and their exact git dates when history is available', () => {
    const samples = ['manage-agents', 'approve-actions', 'sealed-inference', 'corpus-search', BROKER];
    for (const id of samples) {
      const { last_touched: history } = document.capabilities.find(c => c.id === id).evidence;
      expect(() => evidenceFile(ROOT, history.path)).not.toThrow();
      // CI intentionally checks out depth 1. Never turn shallow history into
      // a false date: compare only if the cited historical object is present.
      const probe = spawnSync('git', ['cat-file', '-e', `${history.commit}^{commit}`], { cwd: ROOT });
      if (probe.status === 0) {
        const date = execFileSync('git', ['show', '-s', '--format=%cs', history.commit], { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(history.date).toBe(date);
      }
    }
  });

  it('runs through the CLI with a success exit code', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('77 actions');
  });

  it('is picked up by the existing CI Test shards without editing product or dependency configuration', () => {
    const ci = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
    expect(ci.jobs['test-shards'].steps.some(step => step.run?.includes('test:agent --coverage'))).toBe(true);
    expect(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')).toContain('scripts/__tests__/**/*.test.mjs');
  });
});

describe('required objects and fields', () => {
  it.each([null, [], 'wrong'])('rejects a non-object document: %j', value => {
    expect(() => validateMap(value)).toThrow('expected object');
  });

  const fieldGroups = [
    ['document', Object.keys(document), doc => doc],
    ['capability', Object.keys(first(document)), first],
    ['entry_points', Object.keys(first(document).entry_points), doc => first(doc).entry_points],
    ['evidence', Object.keys(first(document).evidence), doc => first(doc).evidence],
    ['history', ['date', 'commit', 'path'], doc => first(doc).evidence.last_touched],
    ['coverage', ['pages', 'specs', 'packages', 'external'], doc => doc.coverage],
  ];
  for (const [name, fields, get] of fieldGroups) {
    it.each(fields)(`requires ${name}.%s`, key => {
      reject(doc => { delete get(doc)[key]; }, REQUIRED_FIELDS);
    });
  }

  for (const field of ['audience', 'maturity', 'business_weight']) {
    it.each(['value', 'rationale', 'paths'])(`requires ${field}.%s`, key => {
      reject(doc => { delete first(doc)[field][key]; }, REQUIRED_FIELDS);
    });
    it(`rejects an unknown ${field} enum`, () => {
      reject(doc => { first(doc)[field].value = 'invented'; }, 'invalid enum');
    });
    it(`requires ${field} rationale and citations`, () => {
      reject(doc => { first(doc)[field].rationale = ' '; }, 'nonempty string');
      reject(doc => { first(doc)[field].paths = []; }, EXPECTED_ARRAY);
      reject(doc => { first(doc)[field].paths = ['README.md']; }, 'uncatalogued evidence');
    });
  }
  it('rejects extra fields as well as missing fields', () => {
    reject(doc => { first(doc).invented = true; }, REQUIRED_FIELDS);
  });
});

describe('validation rules fail closed', () => {
  it('rejects unsupported schema versions, empty lists and descriptions', () => {
    reject(doc => { doc.schema_version = 2; }, 'unsupported schema');
    reject(doc => { doc.capabilities = []; }, EXPECTED_ARRAY);
    for (const key of ['scope', 'audited_on', 'source_commit']) {
      reject(doc => { doc[key] = ''; });
    }
    for (const key of ['id', 'name', 'action']) reject(doc => { first(doc)[key] = ''; });
    reject(doc => { first(doc).services = []; }, EXPECTED_ARRAY);
    reject(doc => { first(doc).services = ['auth', 'auth']; }, 'duplicate values');
  });

  it('rejects duplicate or malformed IDs', () => {
    reject(doc => { doc.capabilities.push(structuredClone(first(doc))); }, 'duplicate capability id');
    reject(doc => { first(doc).id = '/auth'; }, 'invalid capability id');
  });

  it.each(['yesterday', '2026-02-30', '2026-13-01', '2026-1-1'])('rejects invalid dates: %s', value => {
    reject(doc => { first(doc).evidence.last_touched.date = value; }, /invalid .*date/);
  });
  it('rejects future evidence, abbreviated SHAs and unknown history paths', () => {
    reject(doc => { first(doc).evidence.last_touched.date = '2027-01-01'; }, 'after audit');
    reject(doc => { first(doc).evidence.last_touched.commit = '123abcd'; }, 'full commit SHA');
    reject(doc => { first(doc).evidence.last_touched.path = 'README.md'; }, 'not in evidence');
  });

  it('rejects unknown apps, unsupported app claims and omission of an existing app', () => {
    reject(doc => { first(doc).apps.push('imaginary'); }, 'unknown app');
    reject(doc => { first(doc).apps.push('corpus'); }, 'lacks evidence');
    reject(doc => { doc.capabilities.forEach(c => { c.apps = c.apps.filter(withoutBroker); }); }, 'every apps/*');
  });

  it('rejects missing files, directories, empty citations and duplicate paths', () => {
    reject(doc => { first(doc).evidence.paths.push('missing-file.ts'); }, /ENOENT/);
    reject(doc => { first(doc).evidence.paths.push('apps/kernel'); }, 'must be a file');
    reject(doc => { first(doc).evidence.paths = []; }, EXPECTED_ARRAY);
    reject(doc => { first(doc).evidence.paths.push(first(doc).evidence.paths[0]); }, 'duplicate values');
  });

  it.each(['../README.md', '/etc/passwd', 'C:/outside', './README.md', 'apps//kernel', 'apps/../README.md', 'apps\\kernel'])
    ('rejects unsafe evidence paths: %s', value => {
      expect(() => evidenceFile(ROOT, value)).toThrow('unsafe evidence path');
    });
  it('rejects symlink/junction escape even if the outside file exists', () => {
    const checkout = join(scratch, 'checkout');
    const outside = join(scratch, 'outside');
    mkdirSync(checkout);
    mkdirSync(outside);
    writeFileSync(join(outside, 'evidence.txt'), 'outside');
    symlinkSync(outside, join(checkout, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => evidenceFile(checkout, 'link/evidence.txt')).toThrow('escapes checkout');
  });

  it('rejects invalid test citations and tests missing from the evidence catalog', () => {
    reject(doc => { first(doc).evidence.tests = [first(doc).evidence.paths[0]]; }, 'not a test file');
    reject(doc => { first(doc).evidence.tests.push('packages/auth/tests/acting-did.test.ts'); }, 'uncatalogued test');
  });
  it.each([0, -1, 1.5, '3350', Number.MAX_SAFE_INTEGER + 1])('rejects invalid issue numbers: %s', value => {
    reject(doc => { first(doc).evidence.open_issues = [value]; }, 'invalid issue number');
  });
  it('rejects duplicate issue references', () => {
    reject(doc => { first(doc).evidence.open_issues = [3350, 3350]; }, 'duplicate issue numbers');
  });

  it('rejects malformed UI and API entrypoints', () => {
    reject(doc => { first(doc).entry_points.ui = ['https://example.test']; }, 'invalid UI');
    reject(doc => { first(doc).entry_points.api = ['FETCH /auth']; }, 'invalid API');
    reject(doc => { first(doc).entry_points.api = ['GET /bad path']; }, 'invalid API');
  });
  it('rejects invalid SDK shape, package path mismatch, absent SDKs and duplicates', () => {
    const sdk = doc => doc.capabilities.find(c => c.entry_points.sdk.length).entry_points.sdk;
    reject(doc => { delete sdk(doc)[0].package; }, REQUIRED_FIELDS);
    reject(doc => { sdk(doc)[0].path = 'README.md'; }, 'must match package');
    reject(doc => { sdk(doc)[0] = { package: 'missing', path: 'packages/missing/package.json' }; }, /ENOENT/);
    reject(doc => { sdk(doc).push(structuredClone(sdk(doc)[0])); }, 'duplicate SDK');
  });

  it('requires tests for works/live and UI, API and navigation citations for live', () => {
    reject(doc => { live(doc).evidence.tests = []; }, 'requires tests');
    reject(doc => { live(doc).entry_points.ui = []; }, 'requires UI and API');
    reject(doc => { live(doc).entry_points.api = []; }, 'requires UI and API');
    reject(doc => { live(doc).maturity.paths = live(doc).maturity.paths.filter(p => !/(?:nav|layout)\.tsx$/.test(p)); }, 'navigation evidence');
    reject(doc => { first(doc).maturity.value = 'works'; first(doc).evidence.tests = []; }, 'requires tests');
  });
  it('requires both 60-day inactivity and no-inbound-links audit evidence for dormant', () => {
    reject(doc => { first(doc).maturity.value = 'dormant'; }, 'no inbound links');
    reject(doc => {
      first(doc).maturity.value = 'dormant';
      first(doc).maturity.rationale = 'Audit found no inbound links.';
      first(doc).evidence.last_touched.date = doc.audited_on;
    }, 'requires 60 days');
    const doc = copy();
    first(doc).maturity.value = 'dormant';
    first(doc).maturity.rationale = 'Audit found no inbound links.';
    first(doc).evidence.last_touched.date = '2026-01-01';
    expect(() => validateMap(doc)).not.toThrow();
  });
});

describe('coverage, docs and parser regressions', () => {
  for (const type of ['pages', 'specs', 'packages']) {
    it(`rejects missing, duplicate and foreign ${type} coverage`, () => {
      reject(doc => { doc.coverage[type].pop(); }, `coverage.${type}`);
      reject(doc => { doc.coverage[type].push(structuredClone(doc.coverage[type][0])); }, 'duplicate coverage path');
      reject(doc => { doc.coverage[type][0].path = 'README.md'; }, `coverage.${type}`);
      reject(doc => { doc.coverage[type][0].capabilities = ['imaginary']; }, 'unknown capability reference');
    });
  }
  it('requires capability references on page/spec entries and a rationale on tooling packages', () => {
    reject(doc => { doc.coverage.pages[0].capabilities = []; }, EXPECTED_ARRAY);
    reject(doc => { doc.coverage.specs[0].capabilities = []; }, EXPECTED_ARRAY);
    reject(doc => { doc.coverage.packages[0].note = ''; }, 'nonempty string');
  });
  it('checks extracted-app evidence without inventing local grades', () => {
    reject(doc => { doc.coverage.external[0].service = 'kernel'; }, 'local or duplicate');
    reject(doc => { doc.coverage.external.push(structuredClone(doc.coverage.external[0])); }, 'local or duplicate');
    reject(doc => { doc.coverage.external[0].evidence = ['missing.md']; }, /ENOENT/);
    reject(doc => { delete doc.coverage.external[0].grade; }, REQUIRED_FIELDS);
    reject(doc => { doc.coverage.external[0].capabilities = []; }, EXPECTED_ARRAY);
  });
  it.each(['Grading rubric', 'Per-audience main jobs', 'Primary navigation proposal', 'Positioning cut for #3284', 'Gaps and limitations'])
    ('requires README acceptance section %s', heading => {
      expect(() => validateGuide(guide.replaceAll(`## ${heading}`, '## Removed'), document)).toThrow('guide missing');
    });
  it('rejects missing or duplicated table markers and row drift', () => {
    expect(() => validateGuide(guide.replaceAll('<!-- capability-table:start -->', ''), document)).toThrow('start marker');
    expect(() => validateGuide(guide.replaceAll('<!-- capability-table:end -->', ''), document)).toThrow('end marker');
    expect(() => validateGuide(guide + '<!-- capability-table:start -->', document)).toThrow('start marker');
    expect(() => validateGuide(guide.replaceAll('Evaluate agent identity and authority', 'Made up'), document)).toThrow('table drift');
    expect(renderTable([{ ...first(document), evidence: { ...first(document).evidence, tests: [] } }])).toContain('[implementation]');
  });
  it.each(['a: [', 'schema_version: 1\nschema_version: 2', 'a: &x [1]\nb: *x'])
    ('rejects malformed YAML, duplicate keys and aliases: %s', value => {
      expect(() => parseMap(value)).toThrow();
    });
  it('returns a nonzero CLI status for a broken map', () => {
    // Run an isolated copy so neither a failing CLI test nor its fixtures
    // writes to the real docs under test.
    const isolated = join(scratch, 'cli');
    mkdirSync(join(isolated, 'scripts'), { recursive: true });
    mkdirSync(join(isolated, 'docs/capabilities'), { recursive: true });
    writeFileSync(join(isolated, SCRIPT), readFileSync(join(ROOT, SCRIPT)));
    writeFileSync(join(isolated, MAP_PATH), 'schema_version: 999\n');
    symlinkSync(join(ROOT, 'node_modules'), join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: isolated, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Capability map invalid');
  });
});
