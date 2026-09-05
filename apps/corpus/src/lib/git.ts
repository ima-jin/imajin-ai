/**
 * Git ref resolution for sha-pinned snapshot queries (#1921).
 *
 * "Repo sources" in this codebase are ingested exclusively through the
 * `LocalAdapter` (`../adapters/local.ts`) against a `local:workspace...`
 * source whose filesystem root is a git checkout maintained outside the
 * corpus service (`./workspace.ts`). This module resolves the sha that
 * checkout is at, so ingest can record which ref a snapshot belongs to.
 */
import { execFileSync } from 'node:child_process';

/**
 * Resolves the current commit sha of the git checkout rooted at
 * `workspaceRoot`, or `undefined` if it isn't a git checkout (or `git` isn't
 * available). Errors are swallowed deliberately: a non-git workspace is a
 * valid, supported configuration — it just never participates in ref-pinned
 * queries.
 */
export function resolveGitRef(workspaceRoot: string): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();

    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}
