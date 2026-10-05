import { describe, it, expect } from 'vitest';
import { sign, signSync, verify, verifySync } from '../src/crypto';
import { generateKeypair } from '../src/crypto';

describe('async sign/verify keep their Promise contract', () => {
  it('sign resolves to the same signature as signSync, and verify accepts it', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const signature = await sign('hello', privateKey);
    expect(signature).toBe(signSync('hello', privateKey));
    await expect(verify(signature, 'hello', publicKey)).resolves.toBe(true);
    expect(verifySync(signature, 'hello', publicKey)).toBe(true);
  });

  it('sign returns a rejected promise (not a synchronous throw) for a malformed key', async () => {
    let pending: Promise<string> | undefined;
    expect(() => { pending = sign('hello', 'not-hex'); }).not.toThrow();
    await expect(pending).rejects.toThrow();
  });

  it('verify resolves false for a malformed signature', async () => {
    const { publicKey } = generateKeypair();
    await expect(verify('zz', 'hello', publicKey)).resolves.toBe(false);
  });
});
