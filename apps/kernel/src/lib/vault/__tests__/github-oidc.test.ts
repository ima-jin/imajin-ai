import { beforeAll, describe, expect, it, vi } from 'vitest';
import { githubGrantee, verifyGithubJob } from '../github-oidc';
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
      workflow: 'ima-jin/example/.github/workflows/deploy.yml@refs/heads/main', runId: '42', runAttempt: '1',
    });
    expect(githubGrantee('ima-jin/example', 'production')).not.toBe(githubGrantee('ima-jin/other', 'production'));
    expect(githubGrantee('ima-jin/example', 'production')).not.toBe(githubGrantee('ima-jin/example', 'dev'));
  });

  it('rejects forged signatures, unsigned tokens and oversized tokens without revealing them', async () => {
    const foreign = await oidcFixture();
    for (const token of [await foreign.token(), 'eyJhbGciOiJub25lIn0.e30.', 'x'.repeat(16385), '']) {
      await expect(verifyGithubJob(token, fixture.keys)).rejects.toMatchObject({ status: 401, message: 'Invalid GitHub OIDC token' });
    }
  });

  it.each([
    { iss: 'https://attacker.invalid' }, { aud: 'other-service' },
    { exp: 1 }, { iat: 1 }, { nbf: 9999999999 }, { exp: undefined }, { jti: undefined },
    { iat: undefined }, { nbf: undefined }, { sub: undefined },
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

  it('accepts environment colons only with GitHub subject encoding', async () => {
    expect(await verifyGithubJob(await fixture.token({
      environment: 'prod:eu', sub: 'repo:ima-jin/example:environment:prod%3Aeu',
    }), fixture.keys)).toMatchObject({ environment: 'prod:eu' });
  });
});
