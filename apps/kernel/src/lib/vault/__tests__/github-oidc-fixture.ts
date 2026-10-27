import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { GITHUB_ISSUER, SSH_OIDC_AUDIENCE } from '../github-oidc';

export async function oidcFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] });
  async function token(overrides: JWTPayload = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: GITHUB_ISSUER, aud: SSH_OIDC_AUDIENCE, sub: 'repo:ima-jin/example:environment:production',
      repository: 'ima-jin/example', environment: 'production',
      repository_id: '123', repository_owner_id: '456',
      workflow_ref: 'ima-jin/example/.github/workflows/deploy.yml@refs/heads/main',
      run_id: '42', run_attempt: '1', jti: 'test-job', iat: now, nbf: now, exp: now + 300, ...overrides,
    }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
  }
  return { keys, token };
}
