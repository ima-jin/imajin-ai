/**
 * Tests for the rail-generic route alias helpers (#2177 item 3).
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': '*' }),
}));

import { normalizeChargeRecipient, railAliasOptions, railAliasRoute, type RailAnnotator } from '../rail-alias';

const annotateProvider: RailAnnotator = (provider, body) => ({ ...body, provider });

const request = new Request('https://kernel.test/pay/api/webhook/stripe') as unknown as NextRequest;
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });

describe('railAliasRoute', () => {
  it('dispatches a known provider to its handler unchanged', async () => {
    const handler = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const res = await railAliasRoute({ stripe: handler })(request, ctx('stripe'));
    expect(handler).toHaveBeenCalledWith(request);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for an unknown provider and never calls a handler', async () => {
    const handler = vi.fn();
    const res = await railAliasRoute({ stripe: handler })(request, ctx('nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown provider: nope' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not resolve Object.prototype keys as providers', async () => {
    const res = await railAliasRoute({ stripe: vi.fn() })(request, ctx('constructor'));
    expect(res.status).toBe(404);
  });

  it('annotates a successful JSON object body, preserving status and headers', async () => {
    const handler = async () =>
      new Response(JSON.stringify({ a: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-keep': 'yes', 'content-length': '7' },
      });
    const res = await railAliasRoute({ stripe: handler }, annotateProvider)(request, ctx('stripe'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-keep')).toBe('yes');
    expect(await res.json()).toEqual({ a: 1, provider: 'stripe' });
  });

  it('does not annotate error responses', async () => {
    const handler = async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
    const res = await railAliasRoute({ stripe: handler }, annotateProvider)(request, ctx('stripe'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('returns a non-JSON success body untouched', async () => {
    const handler = async () => new Response('plain text', { status: 200 });
    const res = await railAliasRoute({ stripe: handler }, annotateProvider)(request, ctx('stripe'));
    expect(await res.text()).toBe('plain text');
  });

  it('returns a non-object JSON success body untouched', async () => {
    const handler = async () => new Response(JSON.stringify([1, 2]), { status: 200 });
    const res = await railAliasRoute({ stripe: handler }, annotateProvider)(request, ctx('stripe'));
    expect(await res.json()).toEqual([1, 2]);
  });

  it('returns a JSON null success body untouched', async () => {
    const handler = async () => new Response('null', { status: 200 });
    const res = await railAliasRoute({ stripe: handler }, annotateProvider)(request, ctx('stripe'));
    expect(await res.json()).toBeNull();
  });
});

describe('railAliasOptions', () => {
  it('answers the CORS preflight with 204', async () => {
    const res = await railAliasOptions(request);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('normalizeChargeRecipient', () => {
  it('passes the original shape through untouched (same object)', () => {
    const to = { stripeCustomerId: 'cus_1' };
    const result = normalizeChargeRecipient(to);
    expect(result).toEqual({ ok: true, to });
    expect(result.ok && result.to).toBe(to);
  });

  it('passes did / solana recipients through untouched', () => {
    expect(normalizeChargeRecipient({ did: 'did:imajin:x' })).toEqual({ ok: true, to: { did: 'did:imajin:x' } });
    expect(normalizeChargeRecipient({ solanaAddress: 'So1' })).toEqual({ ok: true, to: { solanaAddress: 'So1' } });
  });

  it('maps customerId onto the stripe provider field when provider is omitted', () => {
    expect(normalizeChargeRecipient({ customerId: 'cus_1' })).toEqual({ ok: true, to: { stripeCustomerId: 'cus_1' } });
  });

  it('maps customerId + provider "stripe", dropping both generic keys', () => {
    expect(normalizeChargeRecipient({ customerId: 'cus_1', provider: 'stripe' })).toEqual({
      ok: true,
      to: { stripeCustomerId: 'cus_1' },
    });
  });

  it('lets an explicit legacy stripeCustomerId win', () => {
    expect(normalizeChargeRecipient({ customerId: 'cus_new', stripeCustomerId: 'cus_old' })).toEqual({
      ok: true,
      to: { stripeCustomerId: 'cus_old' },
    });
  });

  it('keeps other recipient fields', () => {
    expect(normalizeChargeRecipient({ customerId: 'cus_1', did: 'did:imajin:x' })).toEqual({
      ok: true,
      to: { stripeCustomerId: 'cus_1', did: 'did:imajin:x' },
    });
  });

  it('rejects an unsupported provider', () => {
    expect(normalizeChargeRecipient({ customerId: 'c', provider: 'paypal' })).toEqual({
      ok: false,
      error: 'Unsupported recipient provider: paypal',
    });
    expect(normalizeChargeRecipient({ provider: 42 })).toEqual({
      ok: false,
      error: 'to.provider must be a string',
    });
    expect(normalizeChargeRecipient({ provider: { toString: 'x' } })).toEqual({
      ok: false,
      error: 'to.provider must be a string',
    });
  });

  it('rejects an empty or non-string customerId', () => {
    expect(normalizeChargeRecipient({ customerId: '' })).toEqual({
      ok: false,
      error: 'to.customerId must be a non-empty string',
    });
    expect(normalizeChargeRecipient({ customerId: 7 })).toEqual({
      ok: false,
      error: 'to.customerId must be a non-empty string',
    });
  });

  it('strips a lone provider key when no customerId is given', () => {
    expect(normalizeChargeRecipient({ provider: 'stripe', did: 'did:imajin:x' })).toEqual({
      ok: true,
      to: { did: 'did:imajin:x' },
    });
  });
});
