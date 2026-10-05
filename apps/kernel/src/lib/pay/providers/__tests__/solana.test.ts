/**
 * #2563 — SolanaProvider keeps its Promise contract after the S7503 cleanup:
 * `escrow` rejects (never throws synchronously) and `charge` surfaces
 * validation errors as rejections.
 */
import { describe, it, expect } from 'vitest';
import { SolanaProvider } from '../solana';
import type { ChargeRequest } from '../../types';

const VALID_ADDRESS = '11111111111111111111111111111111';

function provider(rpcUrl = 'https://api.mainnet-beta.solana.com') {
  return new SolanaProvider({ rpcUrl } as ConstructorParameters<typeof SolanaProvider>[0]);
}

describe('SolanaProvider.escrow', () => {
  it('returns a rejected promise rather than throwing synchronously', async () => {
    const p = provider();
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = p.escrow({} as Parameters<SolanaProvider['escrow']>[0]);
    }).not.toThrow();
    await expect(returned).rejects.toThrow('Solana escrow not yet implemented');
  });
});

describe('SolanaProvider.charge', () => {
  it('prepares a SOL transfer', async () => {
    const result = await provider().charge({
      amount: 1000,
      currency: 'SOL',
      to: { solanaAddress: VALID_ADDRESS },
      metadata: { k: 'v' },
    } as ChargeRequest);
    expect(result).toMatchObject({
      provider: 'solana',
      status: 'requires_action',
      amount: 1000,
      currency: 'SOL',
      metadata: { k: 'v', recipientAddress: VALID_ADDRESS, lamports: '1000', type: 'SOL_TRANSFER' },
    });
    expect(result.id).toMatch(/^sol-pending-/);
  });

  it('prepares a USDC transfer with the mainnet mint', async () => {
    const result = await provider().charge({
      amount: 5,
      currency: 'USDC',
      to: { solanaAddress: VALID_ADDRESS },
    } as ChargeRequest);
    expect(result.id).toMatch(/^spl-pending-/);
    expect(result.metadata).toMatchObject({
      type: 'SPL_TRANSFER',
      mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
  });

  it('uses the devnet USDC mint for devnet RPC urls', async () => {
    const result = await provider('https://api.devnet.solana.com').charge({
      amount: 5,
      currency: 'USDC',
      to: { solanaAddress: VALID_ADDRESS },
    } as ChargeRequest);
    expect(result.metadata).toMatchObject({ mintAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' });
  });

  it('rejects an invalid address', async () => {
    await expect(
      provider().charge({ amount: 1, currency: 'SOL', to: { solanaAddress: 'nope' } } as ChargeRequest),
    ).rejects.toThrow('Invalid Solana address: nope');
  });

  it('rejects a DID recipient (resolution not implemented)', async () => {
    await expect(
      provider().charge({ amount: 1, currency: 'SOL', to: { did: 'did:imajin:x' } } as ChargeRequest),
    ).rejects.toThrow('DID resolution not yet implemented');
  });

  it('rejects MJN and unsupported currencies', async () => {
    const to = { solanaAddress: VALID_ADDRESS };
    await expect(provider().charge({ amount: 1, currency: 'MJN', to } as ChargeRequest)).rejects.toThrow(
      'MJN token not yet available',
    );
    await expect(provider().charge({ amount: 1, currency: 'XYZ', to } as unknown as ChargeRequest)).rejects.toThrow(
      'Unsupported currency for Solana: XYZ',
    );
  });
});
