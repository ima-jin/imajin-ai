import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  tier: 'soft',
  blocked: false,
  dailyLimited: false,
  deliveries: 0,
  publish: vi.fn(),
  broker: vi.fn(),
  mint: vi.fn(),
}));
function selectPrincipal() {
  return { from: () => ({ where: principalWhere }) };
}
function principalWhere() {
  return { limit: async () => [{ metadata: {} }] };
}
vi.mock('@/src/db', () => ({
  identities: { id: 'id' }, consentGrants: {},
  db: { select: selectPrincipal },
}));
vi.mock('../crypto', () => ({ verifySignature: async () => true }));
vi.mock('../reach-authority', () => ({
  resolveReachRequester: async () => ({ publicKey: 'verified', tier: mocks.tier }),
  authorizeReachRequester: async (params: { requesterDid: string }) => ({
    authorized: true, stubDid: `stub:${params.requesterDid}`,
  }),
}));
vi.mock('../foreign-principal-stub', () => ({
  resolveOrMintForeignPrincipalStub: (...args: unknown[]) => mocks.mint(...args),
}));
vi.mock('../reach-block', () => ({ isReachSenderBlocked: async () => mocks.blocked }));
vi.mock('../reach-envelope-store', () => ({ markReachPublished: async () => undefined }));
vi.mock('../reach-delivery', () => ({
  deliverReach: async () => {
    if (mocks.dailyLimited) return { outcome: 'rate_limited' };
    mocks.deliveries++;
    return { outcome: 'delivered', reachId: `reach_${mocks.deliveries}`, published: true };
  },
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), emitAttestation: vi.fn().mockResolvedValue({}),
}));
vi.mock('@imajin/bus', () => ({
  publish: (...args: unknown[]) => mocks.publish(...args),
  broker: (...args: unknown[]) => mocks.broker(...args),
  isBrokerRelease: () => true,
}));
vi.mock('@/src/lib/http/node-url', () => ({ agentCardUrl: () => 'https://imajin.ai/agent.json' }));

import {
  guardReachRequester, guardReachIP, readReachBody, reachInputTooLarge,
  REACH_ABUSE_LIMITS as limits, ReachBodyTooLarge,
  reachDailyRetryAfter,
} from '../reach-abuse-guard';
import { reachPrincipal, type ReachRequestInput } from '../agent-reach';
import { POST } from '@/app/auth/api/agents/[did]/reach/route';

let sequence = 0;
let principalDid: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  principalDid = `did:imajin:guard-test-${sequence++}`;
  mocks.tier = 'soft';
  mocks.blocked = false;
  mocks.dailyLimited = false;
  mocks.deliveries = 0;
  mocks.publish.mockReset().mockResolvedValue({});
  mocks.broker.mockReset().mockResolvedValue({ data: { contact_topics: { result: true } } });
  mocks.mint.mockReset().mockImplementation(async (params: { platform: string; externalRef: string }) => ({
    did: `${params.platform}:${params.externalRef}`, isNewStub: false,
  }));
});
afterEach(() => vi.useRealTimers());

function input(agent = 'sender', account = 'account', delivery = true): ReachRequestInput {
  return {
    requesterDid: `did:imajin:${agent}`, onBehalfOf: { platform: 'muse', externalRef: account },
    purpose: 'agent.reach', field: 'contact_topics', predicate: 'contains', arg: 'business_development',
    issuedAt: new Date().toISOString(), signature: 'verified-by-test-seam',
    ...(delivery ? { message: 'private body', topic: 'business_development', replyHandle: 'private handle' } : {}),
  };
}
function throttles() {
  return mocks.publish.mock.calls.filter(([type]) => type === 'agent.reach.throttled');
}
function expectFlood(results: unknown[], cap: number, dimension: string) {
  expect(results.filter((result) => !(result as { denied?: boolean }).denied)).toHaveLength(cap);
  expect(results.slice(cap)).toEqual(Array.from({ length: results.length - cap }, () => expect.objectContaining({
    denied: true, status: 429, reason: 'rate_limited', retryAfter: 60,
  })));
  expect(throttles()).toHaveLength(1);
  expect(throttles()[0][1].payload).toMatchObject({ dimension, principalDid });
  expect(JSON.stringify(throttles())).not.toMatch(/private body|private handle|verified-by-test-seam/);
}

describe('reach abuse budgets with the existing real sliding-window limiter', () => {
  it.each([false, true])('caps concurrent asks/send=%s for one stable agent stub', async (delivery) => {
    const results = await Promise.all(Array.from({ length: limits.stub + 20 }, () =>
      reachPrincipal(principalDid, input('same-agent', 'same-account', delivery))));
    expectFlood(results, limits.stub, 'stub');
    expect(mocks.deliveries).toBe(delivery ? limits.stub : 0);
    expect(mocks.broker).toHaveBeenCalledTimes(limits.stub);
  });

  it('does not mint persistent claimed-principal rows for an exhausted agent rotating account references', async () => {
    for (let n = 0; n < limits.stub + 20; n++) {
      await reachPrincipal(principalDid, input('same-agent', `rotating-account-${n}`));
    }
    expect(mocks.mint).toHaveBeenCalledTimes(limits.stub);
    expect(mocks.deliveries).toBe(limits.stub);
    expect(throttles()).toHaveLength(1);
  });

  it('reports the UTC daily reset, including sub-second rounding at midnight', () => {
    expect(reachDailyRetryAfter()).toBe(12 * 60 * 60);
    expect(reachDailyRetryAfter(Date.parse('2026-10-17T23:59:59.500Z'))).toBe(1);
    expect(reachDailyRetryAfter(Date.parse('2026-10-18T00:00:00Z'))).toBe(24 * 60 * 60);
  });

  it('returns the daily reset in both Retry-After and the single throttled audit', async () => {
    mocks.dailyLimited = true;
    const response = await POST(new NextRequest('https://imajin.ai/reach', {
      method: 'POST', body: JSON.stringify(input()), headers: { 'x-forwarded-for': `daily-${principalDid}` },
    }), { params: Promise.resolve({ did: principalDid }) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('43200');
    expect(throttles()).toHaveLength(1);
    expect(throttles()[0][1].payload).toMatchObject({ dimension: 'daily', retryAfter: 43200 });
    expect(mocks.deliveries).toBe(0);
  });

  it('caps a platform account across fresh signing identities', async () => {
    const results = await Promise.all(Array.from({ length: limits.principal + 12 }, (_, n) =>
      reachPrincipal(principalDid, input(`agent-${n}`, 'one-platform-account'))));
    expectFlood(results, limits.principal, 'principal');
    expect(mocks.deliveries).toBe(limits.principal);
  });

  it.each(['soft', 'preliminary', 'established'] as const)('caps the recipient-wide %s tier pool', async (tier) => {
    mocks.tier = tier;
    const cap = limits.tier[tier];
    const results = await Promise.all(Array.from({ length: cap + 10 }, (_, n) =>
      reachPrincipal(principalDid, input(`agent-${n}`, `account-${n}`))));
    expectFlood(results, cap, 'tier');
    expect(mocks.deliveries).toBe(cap);
  });

  it('shares steward/operator budgets with established and uses conservative unknown-tier limits', async () => {
    const params = { principalDid, requesterDid: 'did:imajin:a', agentStubDid: 'stub-a', onBehalfOf: { platform: 'muse', externalRef: 'human-a' } };
    for (const tier of ['steward', 'operator', 'unrecognized']) {
      expect(await guardReachRequester({ ...params, tier })).toBeNull();
    }
  });

  it('recovers after the window without resetting budgets on retries', async () => {
    for (let n = 0; n < limits.stub; n++) await reachPrincipal(principalDid, input());
    expect(await reachPrincipal(principalDid, input())).toMatchObject({ status: 429 });
    vi.advanceTimersByTime(limits.windowMs + 1);
    expect(await reachPrincipal(principalDid, input())).toMatchObject({ delivered: true });
  });

  it.each([false, true])('caps IP floods with valid-delivery=%s and one privacy-minimal audit', async (valid) => {
    mocks.tier = 'established';
    const ip = `192.0.2.${sequence}`;
    const responses = [];
    for (let n = 0; n < limits.ip + 10; n++) {
      responses.push(await POST(new NextRequest('https://imajin.ai/reach', {
        method: 'POST', headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` },
        body: valid ? JSON.stringify(input(`agent-${n}`, `account-${n}`)) : '{invalid',
      }), { params: Promise.resolve({ did: principalDid }) }));
    }
    expect(responses.slice(0, limits.ip).every((response) => response.status === (valid ? 200 : 400))).toBe(true);
    expect(responses.slice(limits.ip).every((response) => response.status === 429)).toBe(true);
    expect(responses.at(-1)?.headers.get('retry-after')).toBe('60');
    expect(throttles()).toHaveLength(1);
    expect(throttles()[0][1].payload).toMatchObject({ dimension: 'ip' });
    expect(JSON.stringify(throttles())).not.toContain(ip);
    expect(mocks.broker).toHaveBeenCalledTimes(valid ? limits.ip : 0);
    expect(mocks.deliveries).toBe(valid ? limits.ip : 0);
    expect(await guardReachIP(new Request('https://imajin.ai', { headers: { 'x-forwarded-for': `${ip}-other` } }), principalDid)).toBeNull();
  });
});

describe('reach body caps and block preemption', () => {
  it.each([undefined, '1', String(limits.bodyBytes + 1)])('returns 413 for oversized streamed input with Content-Length=%s', async (length) => {
    const request = new NextRequest('https://imajin.ai/reach', {
      method: 'POST', body: JSON.stringify({ arg: 'x'.repeat(limits.bodyBytes) }),
      headers: { 'x-forwarded-for': `body-${principalDid}`, ...(length ? { 'content-length': length } : {}) },
    });
    const response = await POST(request, { params: Promise.resolve({ did: principalDid }) });
    expect(response.status).toBe(413);
    expect(mocks.broker).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes at the transport-independent entry point before signatures or auditing', async () => {
    const request = input();
    request.arg = '😀'.repeat(limits.bodyBytes / 4);
    expect(await reachPrincipal(principalDid, request)).toMatchObject({ status: 413, reason: 'body_too_large' });
    expect(mocks.broker).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(reachInputTooLarge({ arg: 'small' })).toBe(false);
  });

  it('accepts the exact byte boundary and rejects the next streamed chunk while cancelling', async () => {
    const text = JSON.stringify('x'.repeat(limits.bodyBytes - 2));
    expect(await readReachBody(new Request('https://imajin.ai', { method: 'POST', body: text }))).toBe('x'.repeat(limits.bodyBytes - 2));
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limits.bodyBytes));
        controller.enqueue(new Uint8Array(1));
      }, cancel,
    });
    const request = new Request('https://imajin.ai', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await expect(readReachBody(request)).rejects.toBeInstanceOf(ReachBodyTooLarge);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects missing and malformed bodies', async () => {
    await expect(readReachBody(new Request('https://imajin.ai'))).rejects.toThrow('Missing reach body');
    await expect(readReachBody(new Request('https://imajin.ai', { method: 'POST', body: 'no' }))).rejects.toThrow(SyntaxError);
  });

  it.each([false, true])('applies the cascade check before ask/send=%s reaches broker or delivery', async (delivery) => {
    mocks.blocked = true;
    expect(await reachPrincipal(principalDid, input('sender', 'account', delivery))).toMatchObject({
      denied: true, reason: 'unauthorized', status: 403,
    });
    expect(mocks.broker).not.toHaveBeenCalled();
    expect(mocks.deliveries).toBe(0);
  });
});
