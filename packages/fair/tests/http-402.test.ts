import { describe, it, expect } from 'vitest';
import { build402Response } from '../src/http-402';
import type { FairManifestV1_1, SettlementScheme } from '../src';

function makeManifest(overrides?: Partial<FairManifestV1_1>): FairManifestV1_1 {
  return {
    fair: '1.1',
    version: '1.1',
    id: 'asset_test123',
    type: 'image/png',
    owner: 'did:imajin:owner123',
    created: new Date().toISOString(),
    access: { type: 'public' },
    attribution: [
      { did: 'did:imajin:owner123', role: 'creator', share: 0.99 },
      { role: 'platform', name: 'Imajin', share: 0.01 },
    ],
    distribution: {
      reproduction: { mode: 'allowed', price: { amount: 500, currency: 'USD' } },
      streaming: { mode: 'allowed', price: { amount: 1, currency: 'USD' } },
      derivative: { mode: 'allow-with-attribution' },
      syndication: { mode: 'allow-with-attribution' },
    },
    transfer: { allowed: true, requiresAttribution: true, price: { amount: 100000, currency: 'USD' }, resaleRoyaltyBps: 500 },
    fees: [
      { role: 'protocol', name: 'MJN', rateBps: 100, fixedCents: 0 },
    ],
    training: { allowed: false },
    commercial: { allowed: false, contactRequired: true },
    tipping: { enabled: true },
    ...overrides,
  };
}

const ALL_SCHEMES: SettlementScheme[] = ['x402', 'stripe-link', 'mjnx-direct', 'solana-pay', 'lightning'];

describe('build402Response', () => {
  it('builds a 402 for reproduction with all schemes', () => {
    const manifest = makeManifest();
    const result = build402Response({
      manifest,
      assetId: 'asset_test123',
      action: 'reproduction',
      supportedSchemes: ALL_SCHEMES,
      baseUrl: 'https://kernel.imajin.ai/media/api/assets',
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe('payment_required');
    expect(result.body.price).toEqual({ amount: 500, currency: 'USD' });
    expect(result.headers['Content-Type']).toBe('application/fair+json');
    expect(result.headers['Link']).toBe('<https://kernel.imajin.ai/media/api/assets/asset_test123/fair>; rel="fair"');
    expect(result.headers['X-Settle-Endpoint']).toBe('https://kernel.imajin.ai/media/api/assets/asset_test123/settle');
    expect(result.body.settlement.schemes).toEqual(ALL_SCHEMES);
  });

  it('respects manifest settlement schemes override', () => {
    const manifest = makeManifest({
      settlement: { schemes: ['stripe-link', 'mjnx-direct'] },
    });
    const result = build402Response({
      manifest,
      assetId: 'asset_test123',
      action: 'reproduction',
      supportedSchemes: ALL_SCHEMES,
      baseUrl: 'https://kernel.imajin.ai/media/api/assets',
    });

    expect(result.body.settlement.schemes).toEqual(['stripe-link', 'mjnx-direct']);
    expect(result.headers['X-Settle-StripeLink']).toBeDefined();
    expect(result.headers['X-Settle-MjnxDirect']).toBeDefined();
    expect(result.headers['X-Settle-X402']).toBeUndefined();
  });

  it('uses manifest endpoint override when present', () => {
    const manifest = makeManifest({
      settlement: { endpoint: 'https://custom.example.com/pay' },
    });
    const result = build402Response({
      manifest,
      assetId: 'asset_test123',
      action: 'reproduction',
      supportedSchemes: ['stripe-link'],
      baseUrl: 'https://kernel.imajin.ai/media/api/assets',
    });

    expect(result.headers['X-Settle-Endpoint']).toBe('https://custom.example.com/pay');
    expect(result.body.settlement.endpoint).toBe('https://custom.example.com/pay');
  });

  it('includes schemeUrls in headers when provided', () => {
    const manifest = makeManifest();
    const result = build402Response({
      manifest,
      assetId: 'asset_test123',
      action: 'reproduction',
      supportedSchemes: ['stripe-link', 'mjnx-direct'],
      baseUrl: 'https://kernel.imajin.ai/media/api/assets',
      schemeUrls: {
        'stripe-link': 'https://pay.stripe.com/link/test_123',
        'mjnx-direct': 'mjnx:pay?to=did:imajin:owner123&amount=500',
      },
    });

    expect(result.headers['X-Settle-StripeLink']).toBe('https://pay.stripe.com/link/test_123');
    expect(result.headers['X-Settle-MjnxDirect']).toBe('mjnx:pay?to=did:imajin:owner123&amount=500');
    expect(result.body.settlement.urls).toEqual({
      'stripe-link': 'https://pay.stripe.com/link/test_123',
      'mjnx-direct': 'mjnx:pay?to=did:imajin:owner123&amount=500',
    });
  });

  it('throws when action has no price', () => {
    const manifest = makeManifest();
    expect(() =>
      build402Response({
        manifest,
        assetId: 'asset_test123',
        action: 'derivative',
        supportedSchemes: ['stripe-link'],
        baseUrl: 'https://kernel.imajin.ai/media/api/assets',
      }),
    ).toThrow('has no price');
  });

  it('throws when no schemes overlap', () => {
    const manifest = makeManifest({
      settlement: { schemes: ['solana-pay'] },
    });
    expect(() =>
      build402Response({
        manifest,
        assetId: 'asset_test123',
        action: 'reproduction',
        supportedSchemes: ['stripe-link'],
        baseUrl: 'https://kernel.imajin.ai/media/api/assets',
      }),
    ).toThrow('No supported settlement schemes');
  });

  it('includes splits in body when present', () => {
    const manifest = makeManifest({
      distribution: {
        reproduction: {
          mode: 'allowed',
          price: { amount: 1000, currency: 'USD' },
          splits: [
            { did: 'did:imajin:owner123', role: 'creator', share: 0.8 },
            { role: 'platform', name: 'Imajin', share: 0.2 },
          ],
        },
      },
    });
    const result = build402Response({
      manifest,
      assetId: 'asset_test123',
      action: 'reproduction',
      supportedSchemes: ['stripe-link'],
      baseUrl: 'https://kernel.imajin.ai/media/api/assets',
    });

    expect(result.body.splits).toHaveLength(2);
    expect(result.body.splits?.[0].share).toBe(0.8);
  });

  it('works for streaming action', () => {
    const manifest = makeManifest();
    const result = build402Response({
      manifest,
      assetId: 'asset_test123',
      action: 'streaming',
      supportedSchemes: ['stripe-link'],
      baseUrl: 'https://kernel.imajin.ai/media/api/assets',
    });

    expect(result.body.action).toBe('streaming');
    expect(result.body.price).toEqual({ amount: 1, currency: 'USD' });
  });
});
