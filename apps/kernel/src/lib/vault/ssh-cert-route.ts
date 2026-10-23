import { requireAuth } from '@imajin/auth';
import { requireMintAuthority } from './mint-authority';
import { sshCaFailure, sshCaJson } from './ssh-ca-route';
import { SshCaError } from './ssh-ca';
import { isSshCaPurpose } from './ssh-ca-policy';
import { objectInput, onlyKeys, parseSignInput } from './ssh-cert-policy';
import { issueSshGrant, recordSshRefusal, revokeSshGrant, signSshCert, type SshScope } from './ssh-cert';
import { githubGrantee, verifyGithubJob } from './github-oidc';

async function readInput(request: Request) {
  try { return await request.json(); }
  catch { throw new SshCaError(400, 'Invalid JSON'); }
}

export async function signSshCertRoute(request: Request) {
  let grantee: string | null = null;
  try {
    if (request.headers.has('x-github-oidc-token')) {
      const job = await verifyGithubJob(request.headers.get('x-github-oidc-token')!);
      grantee = githubGrantee(job.repository, job.environment);
      const body = objectInput(await readInput(request));
      // The caller cannot substitute audit identity; retain the original route's validation.
      onlyKeys(body, ['purpose', 'caId', 'grantId', 'publicKey', 'principal', 'host', 'ttl']);
      const input = parseSignInput({ ...body, job: `github:${job.repository}:${job.runId}:${job.runAttempt}` });
      return sshCaJson(await signSshCert(input, grantee, job), 201);
    }
    const auth = await requireAuth(request);
    if ('error' in auth) throw new SshCaError(auth.status, 'Authentication required');
    // The authenticated credential is the grantee. Acting-for cannot borrow a grant.
    grantee = auth.identity.id;
    if (grantee.startsWith('did:github:')) throw new SshCaError(401, 'GitHub OIDC token required');
    const input = parseSignInput(await readInput(request));
    return sshCaJson(await signSshCert(input, grantee), 201);
  } catch (error) {
    try { if (grantee) await recordSshRefusal(grantee, error instanceof SshCaError ? error.status : 503); }
    catch { return sshCaFailure(new Error('Audit unavailable')); }
    return sshCaFailure(error);
  }
}

export async function sshGrantRoute(request: Request, revoke = false) {
  try {
    const auth = await requireMintAuthority(request);
    if (!auth.ok) return auth.response;
    const body = objectInput(await readInput(request));
    onlyKeys(body, revoke ? ['purpose', 'grantId']
      : ['purpose', 'grantee', 'repository', 'environment', 'caId', 'principals', 'forceCommand', 'allowedHosts', 'expiresAt']);
    if (!isSshCaPurpose(body.purpose)) throw new SshCaError(400, 'Invalid SSH CA purpose');
    if (revoke) {
      if (typeof body.grantId !== 'string' || !/^vdg_[a-zA-Z0-9_-]{1,100}$/.test(body.grantId)) {
        throw new SshCaError(400, 'Invalid SSH grant id');
      }
      return sshCaJson(await revokeSshGrant(body.purpose, body.grantId, auth.authority));
    }
    const github = body.repository !== undefined || body.environment !== undefined;
    if (github && body.grantee !== undefined) throw new SshCaError(400, 'Choose GitHub identity or DID');
    const grantee = github ? githubGrantee(body.repository, body.environment) : body.grantee;
    if (!github && typeof grantee === 'string' && grantee.startsWith('did:github:')) {
      throw new SshCaError(400, 'GitHub grants require repository and environment');
    }
    if (typeof grantee !== 'string' || typeof body.expiresAt !== 'string') {
      throw new SshCaError(400, 'Grantee and expiry required');
    }
    const scope = { caId: body.caId, principals: body.principals, forceCommand: body.forceCommand,
      allowedHosts: body.allowedHosts } as SshScope;
    const binding = github ? { repository: body.repository as string, environment: body.environment as string } : undefined;
    return sshCaJson(await issueSshGrant(body.purpose, grantee, scope, new Date(body.expiresAt), auth.authority, binding), 201);
  } catch (error) { return sshCaFailure(error); }
}
