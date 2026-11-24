import { db, attestations } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { gitAuthority } from './git-authority';
import { readGitRepository } from './connector';
import { gitError, gitReadTarget } from './git-http';

/** No raw errors are returned or logged: vault/network exceptions may contain credentials. */
export async function githubGitRoute(request: Request): Promise<Response> {
  const target = gitReadTarget(request);
  if (target instanceof Response) return target;
  try {
    const authority = await gitAuthority(request);
    if (typeof authority === 'number') return gitError(authority);
    const audit = await prepareMechanicalAttestation({
      subjectDid: authority.ownerDid,
      type: 'github.git.fetch',
      contextId: target.repo,
      contextType: 'github',
      payload: { ...authority, repo: target.repo, operation: target.suffix, phase: 'requested' },
    });
    // Existing signed history, not a new log table. Audit failure refuses the fetch.
    await db.insert(attestations).values(audit);
    return await readGitRepository(authority.ownerDid, request, target);
  } catch {
    return gitError(403);
  }
}
