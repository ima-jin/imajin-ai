import { describe, it, expect } from 'vitest';
import { createSessionToken, verifySessionToken } from '../src/session';

const config = { secret: 'test-secret-test-secret-test-secret' };
const user = { did: 'did:imajin:abc', handle: 'abc' } as never;

describe('createSessionToken', () => {
  it('resolves to a token that verifySessionToken accepts', async () => {
    const token = await createSessionToken(user, config as never);
    expect(typeof token).toBe('string');
    await expect(verifySessionToken(token, config as never)).resolves.toMatchObject({ did: 'did:imajin:abc' });
  });

  it('returns a rejected promise (not a synchronous throw) when the token cannot be built', async () => {
    // A non-numeric maxAge makes setExpirationTime throw while the JWT is being assembled.
    const broken = { ...config, maxAge: Symbol('bad') } as never;
    let pending: Promise<string> | undefined;
    expect(() => { pending = createSessionToken(user, broken); }).not.toThrow();
    await expect(pending).rejects.toThrow();
  });
});
