import { describe, it, expect } from 'vitest';
import * as auth from '../../packages/auth/src/index.ts';
import { mintAndVerifyScopedToken } from '../smoke/sdk-mint-verify.mjs';

describe('mintAndVerifyScopedToken', () => {
  it('mints a DID-signed scoped message and verifies it, using only the auth module surface', async () => {
    const result = await mintAndVerifyScopedToken(auth);

    expect(result.did).toMatch(/^did:imajin:[0-9a-f]{16}$/);
    expect(result.scopes).toEqual(['profile:read']);
    expect(result.signed.from).toBe(result.did);
    expect(result.signed.payload).toEqual({ scopes: ['profile:read'] });
  });

  it('honors a custom scopes option', async () => {
    const result = await mintAndVerifyScopedToken(auth, { scopes: ['wallet:read', 'wallet:write'] });

    expect(result.scopes).toEqual(['wallet:read', 'wallet:write']);
    expect(result.signed.payload).toEqual({ scopes: ['wallet:read', 'wallet:write'] });
  });

  it('throws when verification fails (e.g. a tampered payload)', async () => {
    const tamperingAuthModule = {
      ...auth,
      verify: async () => ({ valid: false, error: 'signature mismatch' }),
    };

    await expect(mintAndVerifyScopedToken(tamperingAuthModule)).rejects.toThrow(/signature mismatch/);
  });
});
