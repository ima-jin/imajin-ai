import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeKeyKid, crypto as authCrypto } from '@imajin/auth';
import { canonicalKernelWebhookPayload } from '@imajin/auth/kernel-webhook';
import { getKernelWebhookSigner, registerKernelWebhookSigner, webhookReactor } from '../src/reactors/webhook';
import type { BusEvent } from '../src/types';

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => log }));
vi.mock('@imajin/db', () => ({ getClient: () => async () => [] }));
const fetchMock = vi.fn();
const audience = 'did:imajin:events';
const url = 'https://events.test/events/api/webhook/settlement?tenant=%2F&v=2';
const event: BusEvent = {
  id: 'evt_test', type: 'settlement.completed', issuer: 'did:imajin:buyer',
  subject: 'did:imajin:seller', scope: 'events', timestamp: new Date().toISOString(),
  correlationId: 'correlation-test', payload: { orderId: 'order_test', message: 'héllo' },
};

beforeEach(() => {
  vi.clearAllMocks();
  registerKernelWebhookSigner(null);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => {
  registerKernelWebhookSigner(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('signed bus webhook reactor', () => {
  it('does nothing when no callback URL is configured', async () => {
    await webhookReactor(event, {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('requires an explicit recipient for arbitrary webhook configs, never from payload', async () => {
    const signer = vi.fn(() => ({}));
    registerKernelWebhookSigner(signer);
    const other = { ...event, type: 'custom.delivery', payload: { appDid: audience } };
    await expect(webhookReactor(other, { url })).rejects.toThrow('recipient is required');
    expect(signer).not.toHaveBeenCalled();
    await expect(webhookReactor(other, { url, recipient: { appDid: audience } })).rejects.toThrow('omitted');
    expect(signer).toHaveBeenCalledWith(url, expect.any(String), { appDid: audience });
  });

  it('fails closed without a registered signer even with a legacy DB config secret', async () => {
    expect(getKernelWebhookSigner()).toBeUndefined();
    await expect(webhookReactor(event, { url, secret: 'obvious-fake-placeholder' })).rejects.toThrow('not registered');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends after a signer failure or missing signature header', async () => {
    registerKernelWebhookSigner(() => { throw new Error('signing unavailable'); });
    await expect(webhookReactor(event, { url })).rejects.toThrow('signing unavailable');
    registerKernelWebhookSigner(() => ({}));
    await expect(webhookReactor(event, { url })).rejects.toThrow('omitted x-kernel-kid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs and sends the identical serialized bytes without legacy authority or redirect forwarding', async () => {
    const pair = authCrypto.generateKeypair();
    const sign = vi.fn((target: string, rawBody: string) => {
      const headers = {
        'x-kernel-audience': audience,
        'x-kernel-kid': computeKeyKid(pair.publicKey),
        'x-kernel-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-kernel-nonce': randomUUID(),
      };
      return { ...headers, 'x-kernel-signature': authCrypto.signSync(canonicalKernelWebhookPayload({
        audience, url: target, rawBody, method: 'POST',
        timestamp: headers['x-kernel-timestamp'], nonce: headers['x-kernel-nonce'],
      }), pair.privateKey) };
    });
    registerKernelWebhookSigner(sign);
    await webhookReactor(event, { url, secret: 'obvious-fake-placeholder' });
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(sign).toHaveBeenCalledWith(target, init.body, { appSlug: 'events' });
    expect(JSON.parse(init.body as string)).toEqual({
      type: event.type, issuer: event.issuer, subject: event.subject, scope: event.scope,
      payload: event.payload, timestamp: event.timestamp, correlationId: event.correlationId,
    });
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-webhook-secret');
    expect(headers).not.toHaveProperty('Authorization');
    const canonical = (body: string, targetUrl = target) => canonicalKernelWebhookPayload({
      audience, url: targetUrl, rawBody: body, method: 'POST',
      timestamp: headers['x-kernel-timestamp'], nonce: headers['x-kernel-nonce'],
    });
    expect(authCrypto.verifySync(headers['x-kernel-signature'], canonical(init.body as string), pair.publicKey)).toBe(true);
    expect(authCrypto.verifySync(headers['x-kernel-signature'], canonical('{}'), pair.publicKey)).toBe(false);
    expect(authCrypto.verifySync(headers['x-kernel-signature'], canonical(init.body as string, url.replace('v=2', 'v=3')), pair.publicKey)).toBe(false);
  });

  it('logs downstream failures without falling back to unsigned delivery', async () => {
    registerKernelWebhookSigner(() => ({
      'x-kernel-audience': audience, 'x-kernel-kid': 'fake', 'x-kernel-timestamp': '1',
      'x-kernel-nonce': 'fake', 'x-kernel-signature': 'fake',
    }));
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await webhookReactor(event, { url });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }), 'Webhook delivery failed');
  });

  it('keeps the settlement base path and query without configuring legacy secret authority', async () => {
    vi.stubEnv('EVENTS_SERVICE_URL', 'https://events.test/events/?tenant=%2F&v=2');
    vi.resetModules();
    const { getChainConfig } = await import('../src/config');
    const chain = await getChainConfig('settlement.completed', 'events');
    const webhook = chain.reactors.find((reactor) => reactor.type === 'webhook');
    expect(webhook?.config.url).toBe(url);
    expect(webhook?.config.recipient).toEqual({ appSlug: 'events' });
    expect(webhook?.config).not.toHaveProperty('secret');
  });

  it('shares the registered signer across separately loaded module copies', async () => {
    const signer = () => ({});
    registerKernelWebhookSigner(signer);
    vi.resetModules();
    const secondCopy = await import('../src/reactors/webhook');
    expect(secondCopy.getKernelWebhookSigner()).toBe(signer);
  });
});
