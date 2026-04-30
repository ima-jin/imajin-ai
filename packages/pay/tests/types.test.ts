import { describe, it, expect } from 'vitest';
import {
  isFiatCurrency,
  isCryptoCurrency,
  isDIDRecipient,
  isStripeRecipient,
  isSolanaRecipient,
} from '../src/types';

describe('isFiatCurrency', () => {
  it('accepts USD, CAD, EUR, GBP', () => {
    expect(isFiatCurrency('USD')).toBe(true);
    expect(isFiatCurrency('CAD')).toBe(true);
    expect(isFiatCurrency('EUR')).toBe(true);
    expect(isFiatCurrency('GBP')).toBe(true);
  });

  it('rejects crypto currencies', () => {
    expect(isFiatCurrency('SOL')).toBe(false);
    expect(isFiatCurrency('USDC')).toBe(false);
    expect(isFiatCurrency('MJN')).toBe(false);
  });
});

describe('isCryptoCurrency', () => {
  it('accepts SOL, USDC, MJN', () => {
    expect(isCryptoCurrency('SOL')).toBe(true);
    expect(isCryptoCurrency('USDC')).toBe(true);
    expect(isCryptoCurrency('MJN')).toBe(true);
  });

  it('rejects fiat currencies', () => {
    expect(isCryptoCurrency('USD')).toBe(false);
    expect(isCryptoCurrency('EUR')).toBe(false);
  });
});

describe('isDIDRecipient', () => {
  it('detects DID recipient', () => {
    expect(isDIDRecipient({ did: 'did:imajin:abc' })).toBe(true);
  });

  it('rejects non-DID recipients', () => {
    expect(isDIDRecipient({ solanaAddress: 'abc' })).toBe(false);
    expect(isDIDRecipient({ stripeAccountId: 'acct_123' })).toBe(false);
  });
});

describe('isStripeRecipient', () => {
  it('detects stripeAccountId', () => {
    expect(isStripeRecipient({ stripeAccountId: 'acct_123' })).toBe(true);
  });

  it('detects stripeCustomerId', () => {
    expect(isStripeRecipient({ stripeCustomerId: 'cus_123' })).toBe(true);
  });

  it('rejects non-Stripe recipients', () => {
    expect(isStripeRecipient({ did: 'did:imajin:abc' })).toBe(false);
  });
});

describe('isSolanaRecipient', () => {
  it('detects solanaAddress', () => {
    expect(isSolanaRecipient({ solanaAddress: 'abc123' })).toBe(true);
  });

  it('rejects non-Solana recipients', () => {
    expect(isSolanaRecipient({ did: 'did:imajin:abc' })).toBe(false);
  });
});
