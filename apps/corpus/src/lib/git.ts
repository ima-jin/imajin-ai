/**
 * Git ref resolution for sha-pinned snapshot queries (#1921).
 *
 * "Repo sources" in this codebase are ingested exclusively through the
 * `LocalAdapter` (`../adapters/local.ts`) against a `local:workspace...`
 * source whose filesystem root is a git checkout maintained outside the
 * corpus service (`./workspace.ts`). This module resolves the sha that
 * checkout is at, so ingest can record which ref a snapshot belongs to.
 *
 * Deliberately does NOT shell out to the `git` binary (avoids a PATH-based
 * binary resolution security hotspot, SonarCloud S4036 — "Make sure the
 * PATH variable only contains fixed, unwritable directories"). Instead it
 * reads the on-disk `.git` layout directly: `HEAD`, loose refs, and
 * `packed-refs`, following the `gitdir:`/`commondir` indirection linked
 * worktrees use.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SYMBOLIC_REF_PATTERN = /^ref:\s*(\S+)$/;
const GITDIR_POINTER_PATTERN = /^gitdir:\s*(.+)$/;

/**
 * Resolves the current commit sha of the git checkout rooted at
 * `workspaceRoot`, or `undefined` if it isn't a git checkout (or HEAD can't
 * be resolved to a valid 40-hex sha). Errors are swallowed deliberately: a
 * non-git workspace is a valid, supported configuration — it just never
 * participates in ref-pinned queries.
 */
export function resolveGitRef(workspaceRoot: string): string | undefined {
  const gitDir = resolveGitDir(workspaceRoot);
  if (!gitDir) {
    return undefined;
  }

  const head = readTrimmed(join(gitDir, 'HEAD'));
  if (!head) {
    return undefined;
  }

  const symbolicMatch = SYMBOLIC_REF_PATTERN.exec(head);
  if (!symbolicMatch) {
    return isSha(head) ? head : undefined;
  }

  return resolveRef(resolveCommonDir(gitDir), symbolicMatch[1]);
}

function isSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolves the `.git` entry under `workspaceRoot` to an absolute git-dir
 * path, following the `gitdir: <path>` indirection a linked worktree's
 * `.git` file uses (a plain file instead of a directory).
 */
function resolveGitDir(workspaceRoot: string): string | undefined {
  const dotGitPath = join(workspaceRoot, '.git');
  let stats;
  try {
    stats = statSync(dotGitPath);
  } catch {
    return undefined;
  }

  if (stats.isDirectory()) {
    return dotGitPath;
  }
  if (!stats.isFile()) {
    return undefined;
  }

  const content = readTrimmed(dotGitPath);
  const match = content ? GITDIR_POINTER_PATTERN.exec(content) : null;
  if (!match) {
    return undefined;
  }

  const gitdir = match[1].trim();
  return isAbsolute(gitdir) ? gitdir : join(workspaceRoot, gitdir);
}

/**
 * Resolves the shared "common" git-dir (where `refs`/`packed-refs` live) for
 * `gitDir`, following the `commondir` file a linked worktree's private
 * git-dir contains. Returns `gitDir` itself for a regular (non-worktree) repo.
 */
function resolveCommonDir(gitDir: string): string {
  const commondir = readTrimmed(join(gitDir, 'commondir'));
  if (!commondir) {
    return gitDir;
  }
  return isAbsolute(commondir) ? commondir : join(gitDir, commondir);
}

/** Resolves `refName` (e.g. `"refs/heads/main"`) to a sha: loose ref file first, then `packed-refs`. */
function resolveRef(commonDir: string, refName: string): string | undefined {
  const loose = readTrimmed(join(commonDir, refName));
  if (loose && isSha(loose)) {
    return loose;
  }

  return resolvePackedRef(commonDir, refName);
}

function resolvePackedRef(commonDir: string, refName: string): string | undefined {
  const packed = readTrimmed(join(commonDir, 'packed-refs'));
  if (!packed) {
    return undefined;
  }

  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) {
      continue;
    }
    const [sha, name] = line.split(' ');
    if (name === refName && sha && isSha(sha)) {
      return sha;
    }
  }

  return undefined;
}
