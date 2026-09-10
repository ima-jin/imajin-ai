/**
 * Pure logic for `migrate.mjs --owner <app> [--include-shared]` (#1991
 * phase 2a). Extracted from `migrate.mjs` itself so it's testable without a
 * database connection — `migrate.mjs` opens one at import time.
 */

import { ALL_OWNERS } from './migration-ownership-parser.mjs';
import { classifyMigrationFile } from './migration-schema-scan.mjs';

/**
 * Parses `--owner <name>`, `--owner=<name>`, and `--include-shared` out of
 * an argv array (already stripped of `node`/script path, i.e.
 * `process.argv.slice(2)`). Throws on unrecognized arguments, on
 * `--include-shared` without `--owner`, or on an unknown owner name.
 */
export function parseArgs(argv) {
  let owner = null;
  let includeShared = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--include-shared') {
      includeShared = true;
    } else if (arg === '--owner') {
      owner = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--owner=')) {
      owner = arg.slice('--owner='.length);
    } else {
      throw new Error(
        `unrecognized argument "${arg}". Supported: --owner <name>, --owner=<name>, --include-shared.`,
      );
    }
  }

  if (includeShared && !owner) {
    throw new Error('--include-shared requires --owner <name>.');
  }
  if (owner && !ALL_OWNERS.has(owner)) {
    throw new Error(`unknown owner "${owner}". Valid owners: ${[...ALL_OWNERS].sort().join(', ')}.`);
  }

  return { owner, includeShared };
}

/**
 * Decides whether a migration file's `content` is in scope for this run's
 * `--owner` filter. Returns `{ include: true }` or `{ include: false,
 * reason }` — the reason is meant to be logged so a skip is always
 * visible, never silent. When `owner` is `null` (no `--owner` passed),
 * everything is in scope — this is the unmodified default behavior.
 */
export function scopeForOwner(content, owner, includeShared) {
  if (!owner) return { include: true };

  const classification = classifyMigrationFile(content);
  if (classification.kind === 'single') {
    if (classification.owner === owner) return { include: true };
    return { include: false, reason: `owned by "${classification.owner}", not "${owner}"` };
  }

  // Shared: touches more than one owner's schema (or none — the
  // conservative "unrecognized" case from classifyMigrationFile).
  const owners = [...classification.owners].sort().join(', ') || '(none detected)';
  if (owner === 'kernel' || includeShared) return { include: true };
  return {
    include: false,
    reason: `shared across owners (${owners}); pass --include-shared to run it under --owner ${owner}`,
  };
}
