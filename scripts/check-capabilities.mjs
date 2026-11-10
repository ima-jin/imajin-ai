import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const audiences = ['business buyer', 'org admin', 'developer', 'operator', 'end user/consumer', 'agent (machine)'];
export const maturities = ['live', 'works', 'partial', 'dormant'];
export const weights = ['core', 'supporting', 'side-effect'];
export const pillars = ['agent identity', 'delegated authority', 'signed record and settlement', 'none'];
const fields = ['id', 'name', 'action', 'apps', 'services', 'packages', 'entry_points', 'audience', 'maturity', 'business_weight', 'pillars', 'grade_reason', 'evidence'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) && value.every(nonempty);
const array = value => Array.isArray(value) ? value : [];
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value);

/** Repository-contained files only; no arbitrary filesystem reads from YAML. */
function fileExists(root, path) {
  if (!nonempty(path) || isAbsolute(path) || path.includes('\\')) return false;
  const local = relative(root, resolve(root, path));
  if (local.startsWith('..') || isAbsolute(local)) return false;
  try {
    return statSync(resolve(root, path)).isFile();
  } catch {
    return false;
  }
}

const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const link = path => `[${path.split('/').at(-1)}](../../${path})`;

/** Stable readable projection; editorial sections stay hand-written. */
export function renderCapabilityTables(document) {
  return audiences.map(audience => {
    const rows = document.capabilities.filter(capability => capability.audience === audience);
    const lines = rows.map(capability => {
      const entry = capability.entry_points.ui.at(0) ?? capability.entry_points.api.at(0) ?? capability.entry_points.sdk.at(0) ?? 'library';
      const proof = `${link(capability.evidence.code[0])} · ${capability.evidence.tests[0] ? link(capability.evidence.tests[0]) : 'no tests'}`;
      return `| \`${capability.id}\` — ${cell(capability.name)} | ${cell(capability.action)} | ${cell(capability.services.join(', '))}; \`${cell(entry)}\` | ${capability.maturity} / ${capability.business_weight} | ${capability.pillars.join('; ')} | ${proof} |`;
    });
    return `<details>\n<summary>${audience} (${rows.length})</summary>\n\n| Capability | What you can do | Service; entry | Maturity / weight | Pillar(s) | Code · test |\n| --- | --- | --- | --- | --- | --- |\n${lines.join('\n')}\n\n</details>`;
  }).join('\n\n');
}

function requireFields(value, required, label, errors) {
  if (!record(value)) {
    errors.push(`${label}: expected object`);
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${label}: missing ${key}`);
  }
  return true;
}

function strings(value, label, errors, allowEmpty = false) {
  if (!list(value) || (!allowEmpty && value.length === 0)) errors.push(`${label}: expected ${allowEmpty ? '' : 'nonempty '}string array`);
}

function paths(value, label, root, errors, allowEmpty = false) {
  strings(value, label, errors, allowEmpty);
  if (!Array.isArray(value)) return;
  for (const path of value) {
    if (!fileExists(root, path)) errors.push(`${label}: missing or unsafe file ${String(path)}`);
  }
}

function choice(value, choices, label, errors) {
  if (!choices.includes(value)) errors.push(`${label}: invalid enum ${String(value)}`);
}

function validateEntries(entry, label, root, errors) {
  if (!requireFields(entry, ['ui', 'api', 'sdk', 'specs'], label, errors)) return;
  for (const key of ['ui', 'api', 'sdk']) strings(entry[key], `${label}.${key}`, errors, true);
  paths(entry.specs, `${label}.specs`, root, errors, true);
}

function validateEvidence(evidence, label, root, errors) {
  if (!requireFields(evidence, ['code', 'tests', 'navigation', 'last_touched', 'open_issues'], label, errors)) return;
  paths(evidence.code, `${label}.code`, root, errors);
  paths(evidence.tests, `${label}.tests`, root, errors, true);
  paths(evidence.navigation, `${label}.navigation`, root, errors, true);
  if (!nonempty(evidence.last_touched) || !day(evidence.last_touched)) errors.push(`${label}: invalid last_touched date`);
  strings(evidence.open_issues, `${label}.open_issues`, errors, true);
  for (const issue of Array.isArray(evidence.open_issues) ? evidence.open_issues : []) {
    if (!/^https:\/\/github\.com\/ima-jin\/[\w.-]+\/issues\/[1-9]\d*$/.test(issue)) errors.push(`${label}: invalid issue URL`);
  }
}

function validateGrade(capability, label, errors) {
  choice(capability.audience, audiences, `${label}.audience`, errors);
  choice(capability.maturity, maturities, `${label}.maturity`, errors);
  choice(capability.business_weight, weights, `${label}.business_weight`, errors);
  strings(capability.pillars, `${label}.pillars`, errors);
  for (const pillar of Array.isArray(capability.pillars) ? capability.pillars : []) choice(pillar, pillars, `${label}.pillars`, errors);
  if (array(capability.pillars).includes('none') && capability.pillars.length !== 1) errors.push(`${label}: none must stand alone`);
  if (capability.business_weight === 'core' && array(capability.pillars).includes('none')) errors.push(`${label}: core needs a pillar`);
  if (['live', 'works'].includes(capability.maturity) && !capability.evidence?.tests?.length) errors.push(`${label}: tested maturity needs tests`);
  if (capability.maturity === 'live' && (!capability.entry_points?.ui?.length || !capability.entry_points?.api?.length || !capability.evidence?.navigation?.length)) errors.push(`${label}: live needs UI, API and navigation evidence`);
}

function directories(root, directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
}

function validateHeader(document, errors) {
  if (!requireFields(document, ['schema_version', 'as_of', 'source_commit', 'capabilities'], 'map', errors)) return errors;
  if (document.schema_version !== 1) errors.push('map: unsupported schema_version');
  if (!nonempty(document.as_of) || !day(document.as_of)) errors.push('map: invalid as_of date');
  if (!/^[a-f0-9]{40}$/.test(document.source_commit ?? '')) errors.push('map: invalid source_commit');
  return errors;
}

function validateNames(capability, field, known, label, errors) {
  strings(capability[field], `${label}.${field}`, errors, field === 'packages');
  for (const name of array(capability[field])) {
    if (!known.has(name)) errors.push(`${label}: unknown ${field} ${name}`);
  }
}

function validateCapability(capability, index, context, errors) {
  const { root, ids, knownApps, knownPackages } = context;
  const label = `capabilities[${index}]`;
  if (!requireFields(capability, fields, label, errors)) return;
  for (const field of ['id', 'name', 'action', 'grade_reason']) {
    if (!nonempty(capability[field])) errors.push(`${label}: ${field} must be nonempty`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(capability.id ?? '') || ids.has(capability.id)) errors.push(`${label}: invalid or duplicate id`);
  ids.add(capability.id);
  strings(capability.services, `${label}.services`, errors);
  validateNames(capability, 'apps', knownApps, label, errors);
  validateNames(capability, 'packages', knownPackages, label, errors);
  validateEntries(capability.entry_points, `${label}.entry_points`, root, errors);
  validateEvidence(capability.evidence, `${label}.evidence`, root, errors);
  validateGrade(capability, label, errors);
}

function localSpecs(root, apps) {
  return [...apps].flatMap(app => {
    try {
      return readdirSync(resolve(root, 'apps', app, 'api-spec'))
        .filter(name => name.endsWith('.yaml')).map(name => `apps/${app}/api-spec/${name}`);
    } catch {
      return [];
    }
  });
}

function requireCoverage(known, covered, label, errors) {
  for (const name of known) {
    if (!covered.has(name)) errors.push(`map: uncovered ${label} ${name}`);
  }
}

/** Validate structure AND coverage; adding an app, package or service spec cannot silently escape the map. */
export function validateCapabilities(document, root) {
  const errors = validateHeader(document, []);
  if (errors.length) return errors;
  if (!Array.isArray(document.capabilities) || document.capabilities.length === 0) return ['map: capabilities must be nonempty'];
  const context = {
    root, ids: new Set(), knownApps: new Set(directories(root, 'apps')), knownPackages: new Set(directories(root, 'packages')),
  };
  document.capabilities.forEach((capability, index) => validateCapability(capability, index, context, errors));
  const rows = document.capabilities.filter(record);
  const coveredApps = new Set(rows.flatMap(row => array(row.apps)));
  const coveredPackages = new Set(rows.flatMap(row => array(row.packages)));
  const coveredSpecs = new Set(rows.flatMap(row => array(row.entry_points?.specs)));
  requireCoverage(context.knownApps, coveredApps, 'app', errors);
  requireCoverage(context.knownPackages, coveredPackages, 'package', errors);
  requireCoverage(localSpecs(root, context.knownApps), coveredSpecs, 'spec', errors);
  return errors;
}

export function readCapabilities(path) {
  const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map(error => error.message).join('\n'));
  return document.toJS();
}

export function checkCapabilities(root) {
  const document = readCapabilities(resolve(root, 'docs/capabilities/capabilities.yaml'));
  const errors = validateCapabilities(document, root);
  if (errors.length) return errors;
  const readme = readFileSync(resolve(root, 'docs/capabilities/README.md'), 'utf8').replaceAll('\r\n', '\n');
  if (!readme.includes(renderCapabilityTables(document))) errors.push('README: audience tables differ from YAML');
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkCapabilities(root);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Capability schema, evidence, app/package and spec coverage valid.');
  }
}
