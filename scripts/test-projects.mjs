import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ignoredDirectories = new Set(['node_modules', 'dist', '.next', '.git']);

export function isDatabaseTest(path, source) {
  return (path.includes('/db/') && path.includes('/__tests__/') && path.includes('migration'))
    || /@electric-sql\/pglite|\bPGlite\b|seed[- ]replay/i.test(source);
}

// PGlite suites also live under route/lib tests. Discover them from source so
// adding one does not silently put a new database into the fast unit pool.
export function databaseTestFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) visit(path);
      const included = /^apps\/.*\/__tests__\/.*\.test\.tsx?$/.test(path)
        || /^packages\/[^/]+\/tests\/.*\.test\.ts$/.test(path);
      if (entry.isFile() && included
        && isDatabaseTest(path, readFileSync(join(root, path), 'utf8'))) files.push(path);
    }
  };
  visit('apps');
  visit('packages');
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}
