import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

export const AUDIENCES = [
  'business buyer', 'org admin', 'developer', 'operator',
  'end user/consumer', 'agent (machine)',
];
const MATURITIES = ['live', 'works', 'partial', 'dormant'];
const WEIGHTS = ['core', 'supporting', 'side-effect'];
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAP_PATH = 'docs/capabilities/capabilities.yaml';
export const GUIDE_PATH = 'docs/capabilities/README.md';

function object(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}: required/unknown fields`);
}

function text(value, label) {
  assert(typeof value === 'string' && value.trim().length > 0, `${label}: expected nonempty string`);
}

function list(value, label, minimum = 0) {
  assert(Array.isArray(value) && value.length >= minimum, `${label}: expected array (min ${minimum})`);
}

function strings(value, label, minimum = 0) {
  list(value, label, minimum);
  value.forEach(item => text(item, label));
  assert.equal(new Set(value).size, value.length, `${label}: duplicate values`);
}

function date(value, label) {
  text(value, label);
  const timestamp = Date.parse(value);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(timestamp), `${label}: invalid date`);
  assert.equal(new Date(timestamp).toISOString().slice(0, 10), value, `${label}: invalid calendar date`);
}

function commit(value, label) {
  assert(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), `${label}: expected full commit SHA`);
}

/** File citations must remain inside the checkout, including through symlinks. */
export function evidenceFile(root, value) {
  text(value, 'evidence path');
  assert(!value.includes('\\') && !value.includes(':') && !isAbsolute(value), `unsafe evidence path: ${value}`);
  assert(!value.split('/').some(part => ['', '.', '..'].includes(part)), `unsafe evidence path: ${value}`);
  const file = join(root, value);
  const actual = relative(realpathSync(root), realpathSync(file));
  assert(!actual.startsWith('..') && !isAbsolute(actual), `evidence escapes checkout: ${value}`);
  assert(statSync(file).isFile(), `evidence must be a file: ${value}`);
}

function paths(root, values, label, minimum = 1) {
  strings(values, label, minimum);
  values.forEach(value => evidenceFile(root, value));
}

function grade(root, value, allowed, label, evidence) {
  object(value, ['value', 'rationale', 'paths'], label);
  assert(allowed.includes(value.value), `${label}: invalid enum`);
  text(value.rationale, `${label}.rationale`);
  paths(root, value.paths, `${label}.paths`);
  value.paths.forEach(p => assert(evidence.has(p), `${label}: uncatalogued evidence ${p}`));
}

function entries(root, value) {
  object(value, ['ui', 'api', 'sdk'], 'entry_points');
  strings(value.ui, 'entry_points.ui');
  strings(value.api, 'entry_points.api');
  value.ui.forEach(p => assert(/^\/\S*$/.test(p), `invalid UI entry point: ${p}`));
  value.api.forEach(p => assert(/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(p), `invalid API entry point: ${p}`));
  list(value.sdk, 'entry_points.sdk');
  const packages = new Set();
  for (const sdk of value.sdk) {
    object(sdk, ['package', 'path'], 'SDK');
    text(sdk.package, 'SDK.package');
    assert.equal(sdk.path, `packages/${sdk.package}/package.json`, 'SDK path must match package');
    evidenceFile(root, sdk.path);
    assert(!packages.has(sdk.package), 'duplicate SDK package');
    packages.add(sdk.package);
  }
}

function readiness(capability) {
  const { maturity, evidence, entry_points: entryPoints } = capability;
  if (['works', 'live'].includes(maturity.value)) {
    assert(evidence.tests.length > 0, `${capability.id}: works/live requires tests`);
  }
  if (maturity.value === 'live') {
    assert(entryPoints.ui.length > 0 && entryPoints.api.length > 0, `${capability.id}: live requires UI and API`);
    assert(maturity.paths.some(p => /(?:nav|layout)\.tsx$/.test(p)), `${capability.id}: live requires navigation evidence`);
  }
  if (maturity.value === 'dormant') {
    // Link absence cannot be established by a date alone; require the audit
    // rationale to explicitly record that second half of the rubric.
    assert(/no inbound links/i.test(maturity.rationale), `${capability.id}: dormant requires no inbound links evidence`);
  }
}

function capability(root, value, auditedOn, apps) {
  object(value, [
    'id', 'name', 'action', 'apps', 'services', 'entry_points',
    'audience', 'maturity', 'business_weight', 'evidence',
  ], 'capability');
  assert(typeof value.id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.id), 'invalid capability id');
  text(value.name, 'name');
  text(value.action, 'action');
  strings(value.apps, 'apps');
  value.apps.forEach(app => assert(apps.has(app), `unknown app: ${app}`));
  strings(value.services, 'services', 1);
  entries(root, value.entry_points);
  const e = value.evidence;
  object(e, ['paths', 'tests', 'last_touched', 'open_issues'], 'evidence');
  paths(root, e.paths, 'evidence.paths');
  paths(root, e.tests, 'evidence.tests', 0);
  const catalogue = new Set(e.paths);
  e.tests.forEach(p => {
    assert(/\.test\.(?:ts|tsx|mjs)$/.test(p), `not a test file: ${p}`);
    assert(catalogue.has(p), `uncatalogued test: ${p}`);
  });
  grade(root, value.audience, AUDIENCES, 'audience', catalogue);
  grade(root, value.maturity, MATURITIES, 'maturity', catalogue);
  grade(root, value.business_weight, WEIGHTS, 'business_weight', catalogue);
  object(e.last_touched, ['date', 'commit', 'path'], 'last_touched');
  date(e.last_touched.date, 'last_touched.date');
  assert(e.last_touched.date <= auditedOn, 'last_touched is after audit date');
  commit(e.last_touched.commit, 'last_touched.commit');
  assert(catalogue.has(e.last_touched.path), 'last_touched path not in evidence');
  list(e.open_issues, 'open_issues');
  e.open_issues.forEach(n => assert(Number.isSafeInteger(n) && n > 0, 'invalid issue number'));
  assert.equal(new Set(e.open_issues).size, e.open_issues.length, 'duplicate issue numbers');
  readiness(value);
  if (value.maturity.value === 'dormant') {
    assert(Date.parse(auditedOn) - Date.parse(e.last_touched.date) >= 60 * 86400000, 'dormant requires 60 days');
  }
}

function directories(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'node_modules').map(e => e.name);
}

function files(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => {
    if (['node_modules', '.next', 'dist', '.git'].includes(e.name)) return [];
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? files(root, p) : [p];
  });
}

function coverageIndex(root, rows, expected, ids, type) {
  list(rows, `coverage.${type}`, 1);
  const seen = new Set();
  for (const row of rows) {
    object(row, type === 'packages' ? ['path', 'capabilities', 'note'] : ['path', 'capabilities'], `coverage.${type}`);
    evidenceFile(root, row.path);
    assert(!seen.has(row.path), `duplicate coverage path: ${row.path}`);
    seen.add(row.path);
    strings(row.capabilities, 'coverage references', type === 'packages' ? 0 : 1);
    row.capabilities.forEach(id => assert(ids.has(id), `unknown capability reference: ${id}`));
    if (type === 'packages') text(row.note, 'package coverage note');
  }
  assert.deepEqual([...seen].sort(), expected.sort(), `coverage.${type}: missing or unexpected paths`);
}

export function validateMap(document, root = ROOT) {
  object(document, ['schema_version', 'audited_on', 'source_commit', 'scope', 'capabilities', 'coverage'], 'document');
  assert.equal(document.schema_version, 1, 'unsupported schema version');
  date(document.audited_on, 'audited_on');
  commit(document.source_commit, 'source_commit');
  text(document.scope, 'scope');
  list(document.capabilities, 'capabilities', 1);
  const apps = new Set(directories(root, 'apps'));
  const ids = new Set();
  const coveredApps = new Set();
  for (const c of document.capabilities) {
    capability(root, c, document.audited_on, apps);
    assert(!ids.has(c.id), `duplicate capability id: ${c.id}`);
    ids.add(c.id);
    c.apps.forEach(app => {
      assert(c.evidence.paths.some(p => p.startsWith(`apps/${app}/`)), `app ${app} lacks evidence`);
      coveredApps.add(app);
    });
  }
  assert.deepEqual([...coveredApps].sort(), [...apps].sort(), 'every apps/* directory needs a capability');
  object(document.coverage, ['pages', 'specs', 'packages', 'external'], 'coverage');
  const appFiles = files(root, 'apps');
  coverageIndex(root, document.coverage.pages, appFiles.filter(p => p.endsWith('/page.tsx')), ids, 'pages');
  coverageIndex(root, document.coverage.specs, appFiles.filter(p =>
    (p.includes('/api-spec/') && p.endsWith('.yaml')) || p.endsWith('/api/spec/route.ts')), ids, 'specs');
  coverageIndex(root, document.coverage.packages, directories(root, 'packages').map(p => `packages/${p}/package.json`), ids, 'packages');
  list(document.coverage.external, 'coverage.external');
  const external = new Set();
  for (const row of document.coverage.external) {
    object(row, ['service', 'capabilities', 'evidence', 'grade'], 'external');
    text(row.service, 'external.service');
    assert(!apps.has(row.service) && !external.has(row.service), 'external service is local or duplicate');
    external.add(row.service);
    strings(row.capabilities, 'external.capabilities', 1);
    paths(root, row.evidence, 'external.evidence');
    text(row.grade, 'external.grade');
  }
  return document;
}

export function parseMap(content) {
  const doc = parseDocument(content, { uniqueKeys: true });
  assert.equal(doc.errors.length, 0, `invalid YAML: ${doc.errors.map(e => e.message).join('; ')}`);
  return doc.toJS({ maxAliasCount: 0 });
}

/** Kept deterministic so README rows cannot silently diverge from the map. */
export function renderTable(capabilities) {
  let table = '';
  for (const audience of AUDIENCES) {
    table += `\n### ${audience}\n| Capability | What you can do | Maturity | Weight | Evidence |\n| --- | --- | --- | --- | --- |\n`;
    for (const c of capabilities.filter(c => c.audience.value === audience)) {
      const proof = c.evidence.tests[0] ?? c.evidence.paths[0];
      const kind = c.evidence.tests.length ? 'test' : 'implementation';
      table += `| \`${c.id}\` — ${c.name} | ${c.action} | ${c.maturity.value} | ${c.business_weight.value} | [source](../../${c.evidence.paths[0]}), [${kind}](../../${proof}); ${c.evidence.last_touched.date} |\n`;
    }
  }
  return table;
}

export function validateGuide(guide, document) {
  const start = '<!-- capability-table:start -->';
  const end = '<!-- capability-table:end -->';
  assert.equal(guide.split(start).length, 2, 'guide requires one table start marker');
  assert.equal(guide.split(end).length, 2, 'guide requires one table end marker');
  const table = guide.split(start)[1].split(end)[0];
  assert.equal(table.trim(), renderTable(document.capabilities).trim(), 'guide table drift');
  for (const heading of [
    'Grading rubric', 'Per-audience main jobs', 'Primary navigation proposal',
    'Positioning cut for #3284', 'Gaps and limitations',
  ]) assert(guide.includes(`## ${heading}`), `guide missing ${heading}`);
}

export function validateRepository(root = ROOT) {
  const document = validateMap(parseMap(readFileSync(join(root, MAP_PATH), 'utf8')), root);
  validateGuide(readFileSync(join(root, GUIDE_PATH), 'utf8').replaceAll('\r\n', '\n'), document);
  return document;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const document = validateRepository();
    console.log(`Capability map valid: ${document.capabilities.length} actions; all apps, pages, specs and packages covered.`);
  } catch (error) {
    console.error(`Capability map invalid: ${error.message}`);
    process.exitCode = 1;
  }
}
