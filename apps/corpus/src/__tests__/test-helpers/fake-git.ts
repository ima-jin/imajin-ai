/**
 * Fabricates minimal `.git` directory layouts for tests, without spawning a
 * real `git` process. `resolveGitRef` (`../../lib/git.ts`) only ever reads
 * `HEAD`, loose refs, and `packed-refs` — it never inspects commit/tree
 * objects — so tests can construct exactly the files it reads.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Initializes a fake git checkout at `root` with `HEAD` pointing at `branch`. */
export function initFakeGitCheckout(root: string, branch = 'main'): void {
  const gitDir = join(root, '.git');
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
}

/** Points `branch`'s loose ref at `sha`, simulating a commit landing. */
export function setFakeGitHead(root: string, sha: string, branch = 'main'): void {
  const refPath = join(root, '.git', 'refs', 'heads', branch);
  mkdirSync(join(refPath, '..'), { recursive: true });
  writeFileSync(refPath, `${sha}\n`, 'utf8');
}
