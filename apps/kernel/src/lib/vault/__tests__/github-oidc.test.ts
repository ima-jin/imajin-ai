import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GithubPolicyError, githubGrantee, validGithubGrant, verifyGithubJob } from '../github-oidc';
import { oidcFixture } from './github-oidc-fixture';
vi.mock('../ssh-ca', () => ({
  SshCaError: class extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));

let fixture: Awaited<ReturnType<typeof oidcFixture>>;
beforeAll(async () => { fixture = await oidcFixture(); });

describe('GitHub SSH certificate identity', () => {
  it('verifies a real signature and extracts only authenticated job claims', async () => {
    expect(await verifyGithubJob(await fixture.token(), fixture.keys)).toEqual({
      repository: 'ima-jin/example', environment: 'production',
      repositoryId: '123', repositoryOwnerId: '456',
      workflow: 'ima-jin/example/.github/workflows/deploy.yml@refs/heads/main', runId: '42', runAttempt: '1',
      jtiHash: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: expect.any(Number),
    });
    expect(githubGrantee('ima-jin/example', 'production')).not.toBe(githubGrantee('ima-jin/other', 'production'));
    expect(githubGrantee('ima-jin/example', 'production')).not.toBe(githubGrantee('ima-jin/example', 'dev'));
  });

  it('rejects forged signatures, unsigned tokens and oversized tokens without revealing them', async () => {
    const foreign = await oidcFixture();
    for (const token of [await foreign.token(), 'eyJhbGciOiJub25lIn0.e30.', 'x'.repeat(16385), '']) {
      await expect(verifyGithubJob(token, fixture.keys)).rejects.toMatchObject({ status: 401, message: 'Invalid GitHub OIDC token' });
      await expect(verifyGithubJob(token, fixture.keys)).rejects.not.toBeInstanceOf(GithubPolicyError);
    }
  });

  it('does not classify key resolution failures or wrong origins as attributable policy refusals', async () => {
    const keys = vi.fn().mockRejectedValue(new Error('upstream details must not escape'));
    await expect(verifyGithubJob(await fixture.token(), keys)).rejects.not.toBeInstanceOf(GithubPolicyError);
    expect(keys).toHaveBeenCalledTimes(1);
    for (const overrides of [{ iss: 'https://attacker.invalid' }, { aud: 'other-service' },
      { iss: undefined }, { aud: undefined }, { iss: 'https://attacker.invalid', jti: undefined }]) {
      await expect(verifyGithubJob(await fixture.token(overrides), fixture.keys))
        .rejects.not.toBeInstanceOf(GithubPolicyError);
    }
  });

  it.each([
    { jti: undefined }, { exp: 1 }, { iat: 1 }, { nbf: 9999999999 }, { repository_id: 'invalid' },
    { workflow_ref: 'ima-jin/example/.github/workflows/deploy.yml@refs/pull/1/merge' },
  ])('classifies signed matching-origin policy failures without retaining claims %j', async overrides => {
    const failure = await verifyGithubJob(await fixture.token(overrides), fixture.keys).catch(error => error);
    expect(failure).toBeInstanceOf(GithubPolicyError);
    expect(failure).toMatchObject({ status: 401, message: 'Invalid GitHub OIDC token' });
    expect(Object.keys(failure)).toEqual(['status']);
  });

  it('retains JOSE array-audience matching and resolves the verification key only once', async () => {
    const keys = vi.fn(fixture.keys);
    await expect(verifyGithubJob(await fixture.token({
      aud: ['other-service', 'urn:imajin:vault:ssh-cert'],
    }), keys)).resolves.toMatchObject({ repositoryId: '123' });
    expect(keys).toHaveBeenCalledTimes(1);
  });

  it.each([
    { iss: 'https://attacker.invalid' }, { aud: 'other-service' },
    { exp: 1 }, { iat: 1 }, { nbf: 9999999999 }, { exp: undefined }, { jti: undefined },
    { iat: undefined }, { nbf: undefined }, { sub: undefined },
    { jti: '' }, { jti: 'a\nb' }, { jti: 123 }, { jti: 'x'.repeat(257) },
    { exp: Math.floor(Date.now() / 1000) + 3600 },
    { repository_id: undefined }, { repository_id: 123 }, { repository_id: '0' },
    { repository_id: '-1' }, { repository_id: '1'.repeat(21) },
    { repository_owner_id: undefined }, { repository_owner_id: 456 }, { repository_owner_id: '0' },
    { repository: undefined }, { repository: 'invalid' }, { repository: 1 },
    { repository: `${'x'.repeat(101)}/repo` },
    { environment: undefined }, { environment: '' }, { environment: 1 },
    { environment: 'a\nb' }, { environment: 'x'.repeat(129) },
    { workflow_ref: undefined }, { workflow_ref: 1 }, { workflow_ref: 'x'.repeat(513) },
    { workflow_ref: 'ima-jin/other/.github/workflows/deploy.yml@refs/heads/main' },
    { workflow_ref: 'ima-jin/example/.github/workflows/deploy.yml@refs/pull/1/merge' },
    { workflow_ref: 'ima-jin/example/.github/workflows/../deploy.yml@refs/heads/main' },
    { sub: 'repo:ima-jin/example:ref:refs/heads/main' },
    { sub: 'repo:ima-jin/example:environment:dev' },
    { run_id: undefined }, { run_id: 42 }, { run_id: '0' }, { run_id: '4\n2' },
    { run_attempt: undefined }, { run_attempt: '0' }, { run_attempt: 1 },
  ])('refuses invalid authenticated claims %j', async overrides => {
    await expect(verifyGithubJob(await fixture.token(overrides), fixture.keys)).rejects.toMatchObject({ status: 401 });
  });

  it('keeps exact optional workflow refs and rejects invalid grant ids or ref policies', () => {
    const binding = { repository: 'ima-jin/example', environment: 'production',
      repositoryId: '123', repositoryOwnerId: '456' };
    expect(validGithubGrant(binding)).toBe(true);
    const workflow = 'ima-jin/example/.github/workflows/deploy.yml@refs/tags/v1';
    expect(validGithubGrant({ ...binding, allowedRefs: [workflow] })).toBe(true);
    for (const allowedRefs of [null, 'main', [], [1], Array(65).fill(workflow), ['refs/heads/main'],
      ['ima-jin/other/.github/workflows/deploy.yml@refs/heads/main'],
      [workflow + '*'], [workflow + '\n'], ['x'.repeat(513)]]) {
      expect(validGithubGrant({ ...binding, allowedRefs } as never)).toBe(false);
    }
    for (const value of [undefined, null, '', 123, '0', '-1', 'a', '1'.repeat(21)]) {
      expect(validGithubGrant({ ...binding, repositoryId: value } as never)).toBe(false);
      expect(validGithubGrant({ ...binding, repositoryOwnerId: value } as never)).toBe(false);
    }
  });

  it('accepts environment colons only with GitHub subject encoding', async () => {
    expect(await verifyGithubJob(await fixture.token({
      environment: 'prod:eu', sub: 'repo:ima-jin/example:environment:prod%3Aeu',
    }), fixture.keys)).toMatchObject({ environment: 'prod:eu' });
  });
});
