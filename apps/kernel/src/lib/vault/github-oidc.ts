import { createHash } from 'node:crypto';
import { compactVerify, createRemoteJWKSet, decodeJwt, jwtVerify, type CompactVerifyGetKey, type JWTPayload } from 'jose';
import { SshCaError } from './ssh-ca';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const SSH_OIDC_AUDIENCE = 'urn:imajin:vault:ssh-cert';
const githubKeys = createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`), {
  timeoutDuration: 5000,
});

export interface GithubJob {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  workflow: string;
  environment: string;
  runId: string;
  runAttempt: string;
  jtiHash: string;
  expiresAt: number;
}
export interface GithubGrant {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  environment: string;
  allowedRefs?: string[];
}
export const isGithubId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

export function validGithubGrant(binding: GithubGrant): boolean {
  githubGrantee(binding.repository, binding.environment);
  return isGithubId(binding.repositoryId) && isGithubId(binding.repositoryOwnerId)
    && (binding.allowedRefs === undefined || (Array.isArray(binding.allowedRefs)
      && binding.allowedRefs.length > 0 && binding.allowedRefs.length <= 64
      && binding.allowedRefs.every(ref => validWorkflow(ref, binding.repository))));
}

function validWorkflow(workflow: unknown, repository: unknown): workflow is string {
  return typeof workflow === 'string' && workflow.length <= 512 && !hasControls(workflow)
    && workflow.startsWith(`${repository}/.github/workflows/`)
    && /\/\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml@refs\/(?:heads|tags)\/[^\s*?[\]\\]+$/.test(workflow);
}
const hasControls = (value: string) => Array.from(value).some(char => {
  const code = char.codePointAt(0)!;
  return code < 32 || code === 127;
});

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
  if (!validWorkflow(workflow, repository)
    || !isGithubId(payload.repository_id) || !isGithubId(payload.repository_owner_id)
    || !isGithubId(runId)
    || typeof runAttempt !== 'string' || !/^[1-9]\d{0,9}$/.test(runAttempt)
    || payload.sub !== `repo:${repository}:environment:${String(environment).replaceAll(':', '%3A')}`) {
    throw new SshCaError(401, 'Invalid GitHub job identity');
  }
  if (typeof payload.jti !== 'string' || payload.jti.length < 1 || payload.jti.length > 256
    || hasControls(payload.jti) || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
    || payload.exp! <= Math.floor(Date.now() / 1000) || payload.exp! > payload.iat! + 600) {
    throw new SshCaError(401, 'Invalid GitHub token lifetime or identifier');
  }
  return {
    repository: repository as string, environment: environment as string, workflow, runId, runAttempt,
    repositoryId: payload.repository_id, repositoryOwnerId: payload.repository_owner_id,
    jtiHash: createHash('sha256').update(JSON.stringify([GITHUB_ISSUER, payload.jti])).digest('hex'),
    expiresAt: payload.exp!,
  };
}

/** Only this sanitized error permits an audit before a job grantee is resolved. */
export class GithubPolicyError extends SshCaError {
  constructor() { super(401, 'Invalid GitHub OIDC token'); }
}

/** Anonymous failures must not cause audit preparation, signing or database writes. */
async function verifyGithubSignature(token: string, keys: CompactVerifyGetKey) {
  try {
    if (token.length > 16384) throw new Error('Token too large');
    const verified = await compactVerify(token, keys, { algorithms: ['RS256'] });
    // Read origin claims only after signature verification; use JOSE's audience semantics.
    const payload = decodeJwt(token);
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== GITHUB_ISSUER || !audience.includes(SSH_OIDC_AUDIENCE)) {
      throw new Error('Invalid GitHub token origin');
    }
    return verified.key;
  } catch {
    // Neither request bytes nor JOSE/key-fetch errors escape this boundary.
    throw new SshCaError(401, 'Invalid GitHub OIDC token');
  }
}

/** Fixed issuer/JWKS/audience/algorithm: never trust token-selected URLs or unverified claims. */
export async function verifyGithubJob(token: string, keys: CompactVerifyGetKey = githubKeys): Promise<GithubJob> {
  const key = await verifyGithubSignature(token, keys);
  try {
    // Reuse the resolved key (no second JWKS fetch), retaining all JWT validation rules.
    const { payload } = await jwtVerify(token, key, {
      issuer: GITHUB_ISSUER, audience: SSH_OIDC_AUDIENCE, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'jti'],
      maxTokenAge: '10m', clockTolerance: 5,
    });
    return verifiedJob(payload);
  } catch {
    throw new GithubPolicyError();
  }
}
