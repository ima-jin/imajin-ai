import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { SshCaError } from './ssh-ca';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const SSH_OIDC_AUDIENCE = 'urn:imajin:vault:ssh-cert';
const githubKeys = createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`), {
  timeoutDuration: 5000,
});

export interface GithubJob {
  repository: string;
  workflow: string;
  environment: string;
  runId: string;
  runAttempt: string;
}
const hasControls = (value: string) => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Canonical, domain-separated principal fits existing signed delegation grants. */
export function githubGrantee(repository: unknown, environment: unknown): string {
  if (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]{1,39}\/[a-zA-Z0-9_.-]{1,100}$/.test(repository)
    || typeof environment !== 'string' || environment.length < 1 || environment.length > 128
    || hasControls(environment)) {
    throw new SshCaError(400, 'Invalid GitHub repository or environment');
  }
  return `did:github:${createHash('sha256').update(JSON.stringify([repository, environment])).digest('hex')}`;
}

function verifiedJob(payload: JWTPayload): GithubJob {
  const { repository, environment, workflow_ref: workflow, run_id: runId, run_attempt: runAttempt } = payload;
  githubGrantee(repository, environment);
  if (typeof workflow !== 'string' || workflow.length > 512 || hasControls(workflow)
    || !workflow.startsWith(`${repository}/.github/workflows/`)
    || !/\/\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml@refs\/(?:heads|tags)\/\S+$/.test(workflow)
    || typeof runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(runId)
    || typeof runAttempt !== 'string' || !/^[1-9][0-9]{0,9}$/.test(runAttempt)
    || payload.sub !== `repo:${repository}:environment:${String(environment).replaceAll(':', '%3A')}`) {
    throw new SshCaError(401, 'Invalid GitHub job identity');
  }
  return { repository: repository as string, environment: environment as string, workflow, runId, runAttempt };
}

/** Fixed issuer/JWKS/audience/algorithm: never trust token-selected URLs or unverified claims. */
export async function verifyGithubJob(token: string, keys: JWTVerifyGetKey = githubKeys): Promise<GithubJob> {
  try {
    if (token.length > 16384) throw new Error('Token too large');
    const { payload } = await jwtVerify(token, keys, {
      issuer: GITHUB_ISSUER, audience: SSH_OIDC_AUDIENCE, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'jti'],
      maxTokenAge: '10m', clockTolerance: 5,
    });
    return verifiedJob(payload);
  } catch {
    // JOSE errors and request bytes must not reach logs or responses.
    throw new SshCaError(401, 'Invalid GitHub OIDC token');
  }
}
