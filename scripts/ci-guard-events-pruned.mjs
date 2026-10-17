#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', 'coverage', '__tests__']);
const CONFIG_EXTENSIONS = /\.(?:[cm]?[jt]s|json|ya?ml|sh)$/;
const LEGACY_REFERENCE = /apps\/events(?:[/'"\s:]|$)|@imajin\/events(?:-service)?(?:[#/'"\s]|$)/;

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : filesUnder(path);
    if (/\.(?:test|spec)\./.test(entry.name)) return [];
    return CONFIG_EXTENSIONS.test(entry.name) ? [path] : [];
  });
}

// Scan executable/configuration surfaces, not historical audits or immutable SQL.
// Negative guard fixtures and this script necessarily name the forbidden path.
export function eventsWorkspaceReferences(root) {
  const failures = [];
  if (existsSync(join(root, 'apps/events'))) failures.push('apps/events still exists');
  const files = [
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CONFIG_EXTENSIONS.test(entry.name))
      .map((entry) => join(root, entry.name)),
    ...['.github/workflows', 'deploy', 'scripts'].flatMap((dir) => filesUnder(join(root, dir))),
    ...['apps', 'packages'].flatMap((dir) => filesUnder(join(root, dir)))
      .filter((file) => basename(file) === 'package.json' || /config\.[cm]?[jt]s$/.test(file)),
  ];
  for (const file of files) {
    if (!existsSync(file) || basename(file) === 'ci-guard-events-pruned.mjs') continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(?:#|\/\/|\*|\/\*)/.test(line)) return;
      if (LEGACY_REFERENCE.test(line)) failures.push(`${relative(root, file).replaceAll('\\', '/')}:${index + 1}`);
    });
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = eventsWorkspaceReferences(ROOT);
  if (failures.length > 0) {
    console.error(`FAIL: extracted events workspace reference(s):\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS: events is absent from kernel workspace/build/test/deploy configuration.');
  }
}
