/**
 * The kernel's boot-time handoff of its vault-resolved ATTESTATION_INTERNAL_API_KEY
 * to @imajin/auth (#2353 step 4): vault is the only source, a miss is loud.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInternalSecret: vi.fn(),
  provideInternalApiKey: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../vault/internal-secret', () => ({ getInternalSecret: mocks.getInternalSecret }));
vi.mock('@imajin/auth', () => ({ provideInternalApiKey: mocks.provideInternalApiKey }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
}));
vi.mock('next/server', () => ({ NextResponse: { json: vi.fn() } }));

import { provideVaultInternalApiKey } from '../provide-vault-internal-api-key';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ATTESTATION_INTERNAL_API_KEY;
});

describe('provideVaultInternalApiKey', () => {
  it('registers the vault-resolved key for the attestation purpose', async () => {
    mocks.getInternalSecret.mockResolvedValue('vault-resolved-key');

    await provideVaultInternalApiKey();

    expect(mocks.getInternalSecret).toHaveBeenCalledWith('kernel.attestation-internal-api-key');
    expect(mocks.provideInternalApiKey).toHaveBeenCalledWith('vault-resolved-key');
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('logs an error and registers nothing when the vault cannot resolve it — never falls back to env', async () => {
    process.env.ATTESTATION_INTERNAL_API_KEY = 'env-value-must-be-ignored';
    mocks.getInternalSecret.mockRejectedValue(new Error('vault unavailable'));

    await expect(provideVaultInternalApiKey()).resolves.toBeUndefined();

    expect(mocks.provideInternalApiKey).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
  });

  it('logs an error when the vault hands back an empty value (provideInternalApiKey refuses it)', async () => {
    mocks.getInternalSecret.mockResolvedValue('');
    mocks.provideInternalApiKey.mockImplementation(() => {
      throw new Error('empty key');
    });

    await provideVaultInternalApiKey();

    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });
});
