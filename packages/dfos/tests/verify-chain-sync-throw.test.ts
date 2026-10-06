import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyIdentityChain } = vi.hoisted(() => ({ verifyIdentityChain: vi.fn() }));

vi.mock('@metalabel/dfos-protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@metalabel/dfos-protocol')>()),
  verifyIdentityChain,
}));

import { verifyChain } from '../src/bridge';

const throwValue = (value: unknown): never => {
  throw value;
};

describe('verifyChain synchronous failures', () => {
  beforeEach(() => {
    verifyIdentityChain.mockReset();
  });

  it('calls verifyIdentityChain synchronously and rejects (does not throw) on an Error', async () => {
    const boom = new Error('sync boom');
    verifyIdentityChain.mockImplementation(() => throwValue(boom));
    let pending: Promise<unknown> | undefined;
    expect(() => { pending = verifyChain(['a']); }).not.toThrow();
    expect(verifyIdentityChain).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toBe(boom);
  });

  it('wraps a non-Error throw in an Error rejection', async () => {
    verifyIdentityChain.mockImplementation(() => throwValue('plain failure'));
    let pending: Promise<unknown> | undefined;
    expect(() => { pending = verifyChain(['a']); }).not.toThrow();
    await expect(pending).rejects.toThrow('plain failure');
  });

  it('resolves with the verified identity on success', async () => {
    verifyIdentityChain.mockResolvedValue({ did: 'did:dfos:x' });
    await expect(verifyChain(['a'])).resolves.toEqual({ did: 'did:dfos:x' });
  });
});
