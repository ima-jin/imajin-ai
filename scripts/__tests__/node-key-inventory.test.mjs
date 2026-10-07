import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// #2081 acceptance: "every consumer listed with a test or grep guard". The inventory in
// docs/security/node-key-roles-and-rotation.md §8 is the list; this is the guard. It walks
// the repo for non-test code that touches the node key or the accessors that derive from it,
// and requires each such file to be named in §8 (and every §8 entry to still be real), so a
// new consumer cannot ship without a role assigned in the rotation runbook.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docPath = join(repoRoot, 'docs', 'security', 'node-key-roles-and-rotation.md');

// The key itself, plus every accessor that derives a seal key, signing identity or X25519 key from it
// (apps/kernel/src/lib/vault/sealing.ts, packages/vault-core/src/seal.ts).
const CONSUMER_PATTERN =
  /AUTH_PRIVATE_KEY|deriveSealKey|getNodeSigningIdentity|getSealKey|getNodeX(?:Private|Public)Key|getOwnerX(?:Private|Public)Key/;

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.sh']);
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.turbo', 'build', '.warp']);
// Tests, fixtures and test-support files describe behaviour; they are not consumers.
const TEST_PATH = /(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (CODE_EXTENSIONS.has(extensionOf(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

function repoPath(absolute) {
  return relative(repoRoot, absolute).split(sep).join('/');
}

function findConsumers() {
  const found = [];
  for (const file of walk(repoRoot)) {
    const path = repoPath(file);
    if (TEST_PATH.test(path)) continue;
    if (CONSUMER_PATTERN.test(readFileSync(file, 'utf8'))) found.push(path);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/** Parses §8: one ``- `path` — role`` line per file. */
function readManifest() {
  const doc = readFileSync(docPath, 'utf8');
  const start = doc.indexOf('\n## 8. Inventory manifest');
  if (start === -1) throw new Error('docs/security/node-key-roles-and-rotation.md has no "## 8. Inventory manifest" section');
  const entries = [];
  for (const line of doc.slice(start).split('\n')) {
    const match = /^- `([^`]+)` — (.+)$/.exec(line);
    if (match) entries.push({ path: match[1], role: match[2] });
  }
  return entries;
}

describe('node key inventory (#2081)', () => {
  const consumers = findConsumers();
  const manifest = readManifest();
  const listed = new Set(manifest.map((entry) => entry.path));

  it('finds the known core consumers, so the walk itself cannot silently go empty', () => {
    expect(consumers).toEqual(
      expect.arrayContaining([
        'apps/kernel/src/lib/auth/jwt.ts',
        'apps/kernel/src/lib/vault/sealing.ts',
        'apps/kernel/src/lib/auth/emit-mechanical-attestation.ts',
        'scripts/demo/vault-client.ts',
      ]),
    );
    expect(consumers.length).toBeGreaterThan(50);
  });

  it('names every non-test file that uses the node key or a key derived from it', () => {
    const missing = consumers.filter((path) => !listed.has(path));
    expect(
      missing,
      `Add each to §8 of docs/security/node-key-roles-and-rotation.md with its role (S1-S7, D1-D4, ops, or "not a consumer" with the reason):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('lists only files that exist and still use the key (no stale entries)', () => {
    const consumerSet = new Set(consumers);
    const stale = manifest.map((entry) => entry.path).filter((path) => !existsSync(join(repoRoot, path)) || !consumerSet.has(path));
    expect(stale, `Remove or fix these §8 entries:\n${stale.join('\n')}`).toEqual([]);
  });

  it('has no duplicate entries and gives every entry a role', () => {
    expect(listed.size).toBe(manifest.length);
    expect(manifest.filter((entry) => entry.role.trim() === '')).toEqual([]);
  });

  it('keeps the doc honest about the demo vault client the review found missing', () => {
    expect(listed.has('scripts/demo/vault-client.ts')).toBe(true);
    expect(readFileSync(docPath, 'utf8')).toContain('scripts/demo/vault-client.ts');
  });
});
