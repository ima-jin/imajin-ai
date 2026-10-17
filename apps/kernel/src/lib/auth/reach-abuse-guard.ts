import { createHash } from 'node:crypto';
import { getClientIP, rateLimit } from '@imajin/config';
import { publish } from '@imajin/bus';
import { gateTierForIdentityTier } from './reach-tier';

/** Process-local burst budgets use the kernel's existing sliding-window limiter. */
export const REACH_ABUSE_LIMITS = {
  windowMs: 60_000,
  bodyBytes: 64 * 1024,
  ip: 60,
  stub: 5,
  principal: 10,
  tier: { soft: 30, preliminary: 60, established: 120 },
} as const;

type Dimension = 'ip' | 'tier' | 'stub' | 'principal' | 'daily';
interface GuardContext {
  principalDid: string;
  requesterDid?: string;
}

export interface ReachThrottle {
  denied: true;
  reason: 'rate_limited';
  status: 429;
  retryAfter: number;
}

function bucketKey(dimension: Dimension, parts: string[]): string {
  // Neither plaintext IPs nor platform-account references become limiter keys.
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `reach:guard:${dimension}:${digest}`;
}

/** Coalesce a flood into one audit event per bucket/window, not one per rejected request. */
export async function auditReachThrottle(
  context: GuardContext,
  dimension: Dimension,
  key: string,
  retryAfter: number,
  tier?: string,
): Promise<void> {
  if (rateLimit(`reach:throttled:${key}`, 1, REACH_ABUSE_LIMITS.windowMs).limited) return;
  await publish('agent.reach.throttled', {
    issuer: context.requesterDid ?? context.principalDid,
    subject: context.principalDid,
    scope: 'agent',
    payload: {
      ...context, dimension, retryAfter, ...(tier ? { tier } : {}),
      context_id: context.requesterDid ?? context.principalDid,
      context_type: 'agent.reach',
    },
  });
}

async function consume(
  context: GuardContext, dimension: Dimension, parts: string[], cap: number, tier?: string,
): Promise<ReachThrottle | null> {
  const key = bucketKey(dimension, parts);
  const result = rateLimit(key, cap, REACH_ABUSE_LIMITS.windowMs);
  if (!result.limited) return null;
  await auditReachThrottle(context, dimension, key, result.retryAfter, tier);
  return { denied: true, reason: 'rate_limited', status: 429, retryAfter: result.retryAfter };
}

/** Before JSON parsing, key resolution, signature work, or stub minting. */
export function guardReachIP(request: Request, principalDid: string): Promise<ReachThrottle | null> {
  return consume({ principalDid }, 'ip', [getClientIP(request)], REACH_ABUSE_LIMITS.ip);
}

/** Verified identity only: caller-controlled tier labels never select a budget. */
export async function guardReachRequester(params: {
  principalDid: string;
  requesterDid: string;
  agentStubDid: string;
  onBehalfOfStubDid: string;
  tier: unknown;
}): Promise<ReachThrottle | null> {
  const { principalDid, requesterDid, agentStubDid, onBehalfOfStubDid } = params;
  const tier = gateTierForIdentityTier(params.tier) ?? 'soft';
  const context = { principalDid, requesterDid };
  // Claimed platform accounts share a budget across agents and signing keys.
  return await consume(context, 'stub', [principalDid, agentStubDid], REACH_ABUSE_LIMITS.stub)
    ?? await consume(context, 'principal', [principalDid, onBehalfOfStubDid], REACH_ABUSE_LIMITS.principal)
    ?? await consume(context, 'tier', [principalDid, tier], REACH_ABUSE_LIMITS.tier[tier], tier);
}

export function reachInputTooLarge(input: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(input), 'utf8') > REACH_ABUSE_LIMITS.bodyBytes;
}

export class ReachBodyTooLarge extends Error {
  constructor() {
    super('Reach body too large');
  }
}

/** Enforce actual bytes even without Content-Length or with a dishonest header. */
export async function readReachBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length'));
  if (declared > REACH_ABUSE_LIMITS.bodyBytes) throw new ReachBodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing reach body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > REACH_ABUSE_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new ReachBodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
