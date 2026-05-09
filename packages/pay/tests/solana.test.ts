import { describe, it, expect } from 'vitest';
import { SolanaProvider } from '../src/providers/solana';

describe('SolanaProvider.solToLamports', () => {
  it('converts 1 SOL', () => {
    expect(SolanaProvider.solToLamports(1)).toBe(1_000_000_000);
  });

  it('converts 0 SOL', () => {
    expect(SolanaProvider.solToLamports(0)).toBe(0);
  });

  it('converts fractional SOL', () => {
    expect(SolanaProvider.solToLamports(0.5)).toBe(500_000_000);
    expect(SolanaProvider.solToLamports(0.001)).toBe(1_000_000);
  });

  it('rounds to nearest lamport', () => {
    expect(SolanaProvider.solToLamports(0.0000000001)).toBe(0);
    expect(SolanaProvider.solToLamports(0.0000000005)).toBe(1);
  });
});

describe('SolanaProvider.lamportsToSol', () => {
  it('converts 1 billion lamports to 1 SOL', () => {
    expect(SolanaProvider.lamportsToSol(1_000_000_000)).toBe(1);
  });

  it('converts 0 lamports', () => {
    expect(SolanaProvider.lamportsToSol(0)).toBe(0);
  });

  it('round-trips with solToLamports', () => {
    const sol = 3.14159;
    expect(SolanaProvider.lamportsToSol(SolanaProvider.solToLamports(sol))).toBeCloseTo(sol, 8);
  });
});

describe('SolanaProvider.usdcToBaseUnits', () => {
  it('converts 1 USDC', () => {
    expect(SolanaProvider.usdcToBaseUnits(1)).toBe(1_000_000);
  });

  it('converts 0 USDC', () => {
    expect(SolanaProvider.usdcToBaseUnits(0)).toBe(0);
  });

  it('converts fractional USDC', () => {
    expect(SolanaProvider.usdcToBaseUnits(0.01)).toBe(10_000);
    expect(SolanaProvider.usdcToBaseUnits(9.99)).toBe(9_990_000);
  });

  it('rounds sub-micro amounts', () => {
    expect(SolanaProvider.usdcToBaseUnits(0.0000001)).toBe(0);
    expect(SolanaProvider.usdcToBaseUnits(0.0000005)).toBe(1);
  });
});

describe('SolanaProvider.baseUnitsToUsdc', () => {
  it('converts 1 million base units to 1 USDC', () => {
    expect(SolanaProvider.baseUnitsToUsdc(1_000_000)).toBe(1);
  });

  it('round-trips with usdcToBaseUnits', () => {
    const usdc = 25.50;
    expect(SolanaProvider.baseUnitsToUsdc(SolanaProvider.usdcToBaseUnits(usdc))).toBeCloseTo(usdc, 5);
  });
});
