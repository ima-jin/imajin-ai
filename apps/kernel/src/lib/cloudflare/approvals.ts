import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canonicalize } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, identities, identityMembers, operatorApprovals } from '@/src/db';
import { recordApprovalRequested, type OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { verifyOperatorCountersignature } from '@/src/lib/notify/operator-countersign';
import { controlsImportOwner, isImportHuman } from '@/src/lib/vault/import-authority';
import { authorizeZone, type ZoneAuthority } from './authority';
import { mutation } from './audit';
import { dnsRecord, patchDns, cacheRules } from './operations';
import {
  bulkSchema, cacheRuleOutputSchema, cacheRuleSchema, cacheSetSchema, CloudflareError,
  dnsRecordSchema, domainSchema, idSchema, parse,
} from './schemas';

const actorSchema = z.object({ did: z.string().min(1), humanSession: z.boolean() }).strict();
const common = {
  actor: actorSchema, ownerDid: z.string().min(1), domain: domainSchema, zoneId: idSchema,
  expiresAt: z.string().datetime(),
};
const proxyChangeSchema = z.object({
  recordId: idSchema, before: dnsRecordSchema, after: dnsRecordSchema,
}).strict();
const proxyPlanSchema = z.object({ ...common, operation: z.literal('bulk-proxy'),
  changes: z.array(proxyChangeSchema).min(1).max(20) }).strict();
const cachePlanSchema = z.object({ ...common, operation: z.literal('cache-set'),
  before: z.array(cacheRuleOutputSchema).max(20), rules: z.array(cacheRuleSchema).max(20) }).strict();
const planSchema = z.discriminatedUnion('operation', [proxyPlanSchema, cachePlanSchema]);
type Plan = z.infer<typeof planSchema>;
const log = createLogger('kernel:cloudflare');

/** Choose a real current owner/admin's Inbox, never a node-owner shortcut. */
async function approver(authority: ZoneAuthority): Promise<string> {
  if (await isImportHuman(authority.actor.did) && await controlsImportOwner(authority.actor.did, authority.ownerDid)) {
    return authority.actor.did;
  }
  if (await isImportHuman(authority.ownerDid)) return authority.ownerDid;
  const candidates = await db.select({ did: identityMembers.memberDid }).from(identityMembers)
    .innerJoin(identities, eq(identities.id, identityMembers.memberDid)).where(and(
      eq(identityMembers.identityDid, authority.ownerDid), inArray(identityMembers.role, ['owner', 'admin']),
      isNull(identityMembers.removedAt), isNull(identities.suspendedAt),
      eq(identities.scope, 'actor'), eq(identities.subtype, 'human'),
    )).orderBy(asc(identityMembers.memberDid)).limit(100);
  for (const candidate of candidates) {
    if (await controlsImportOwner(candidate.did, authority.ownerDid)) return candidate.did;
  }
  throw new CloudflareError(409, 'human_approver_unavailable');
}

async function stage(authority: ZoneAuthority, detail: Plan) {
  const operatorDid = await approver(authority);
  const proposalId = `cf_${randomUUID()}`;
  const proposal = {
    proposalId, source: 'cloudflare', kind: `cloudflare:${detail.operation}`,
    summary: detail.operation === 'bulk-proxy' ? 'Apply Cloudflare DNS proxy changes' : 'Replace Cloudflare cache rules',
    keysTouched: [`cloudflare.${authority.zoneId}`],
    detail: detail as unknown as Record<string, unknown>,
  };
  if (JSON.stringify(detail).length > 16 * 1024) throw new CloudflareError(400, 'plan_too_large');
  const contentHash = computeApprovalContentHash(proposal);
  await recordApprovalRequested({ ...proposal, operatorDid, contentHash, notificationId: null, signerDid: authority.actor.did });
  return { proposalId, contentHash, status: 'pending', operatorDid };
}

function planContext(authority: ZoneAuthority) {
  return {
    actor: authority.actor, ownerDid: authority.ownerDid, zoneId: authority.zoneId, domain: authority.domain,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

export async function bulkProxy(authority: ZoneAuthority, raw: unknown) {
  const input = parse(bulkSchema, raw);
  const changes = [];
  for (const change of input.changes) {
    const fresh = await authorizeZone(authority.actor, authority.zoneId, authority.domain, 'cloudflare:dns');
    if (fresh.ownerDid !== authority.ownerDid) throw new CloudflareError(403, 'zone_owner_changed');
    const before = await dnsRecord(fresh, change.recordId);
    if (!before.proxiable) throw new CloudflareError(400, 'record_not_proxiable');
    changes.push({ recordId: change.recordId, before, after: { ...before, proxied: change.proxied } });
  }
  const plan = { ...planContext(authority), operation: 'bulk-proxy' as const, changes };
  return input.dryRun ? { changes, dryRun: true } : { changes, dryRun: false, approval: await stage(authority, plan) };
}

export async function setCache(authority: ZoneAuthority, raw: unknown) {
  const input = parse(cacheSetSchema, raw);
  const before = await cacheRules(authority);
  const plan = { ...planContext(authority), operation: 'cache-set' as const, before, rules: input.rules };
  return input.dryRun ? { before, rules: input.rules, dryRun: true }
    : { before, rules: input.rules, dryRun: false, approval: await stage(authority, plan) };
}

async function verifyCard(card: OperatorApprovalCard): Promise<Plan> {
  const plan = parse(planSchema, card.detail);
  const decision = card.decision;
  if (card.source !== 'cloudflare' || card.kind !== `cloudflare:${plan.operation}` || card.status !== 'approved'
    || decision?.decision !== 'approve' || !decision.operatorSignature || !decision.decidedAt
    || decision.decidedBy !== card.operatorDid || Date.parse(plan.expiresAt) <= Date.now()) throw new Error('Unavailable');
  const hash = computeApprovalContentHash({
    proposalId: card.proposalId, source: card.source, kind: card.kind,
    summary: card.summary, keysTouched: card.keysTouched, detail: card.detail,
  });
  if (hash !== card.contentHash || decision.contentHash !== `sha256:${hash}`
    || !await isImportHuman(card.operatorDid) || !await controlsImportOwner(card.operatorDid, plan.ownerDid)) throw new Error('Unavailable');
  const verified = await verifyOperatorCountersignature(card.operatorDid, {
    contentHash: hash, decision: 'approve', decidedAt: decision.decidedAt,
    ...(decision.mode === undefined ? {} : { mode: decision.mode }),
    ...(decision.replyMessage === undefined ? {} : { replyMessage: decision.replyMessage }),
  }, decision.operatorSignature);
  if (!verified.ok) throw new Error('Unavailable');
  return plan;
}

async function freshAuthority(plan: Plan, capability: string) {
  const authority = await authorizeZone(plan.actor, plan.zoneId, plan.domain, capability);
  if (authority.ownerDid !== plan.ownerDid) throw new Error('Unavailable');
  return authority;
}

async function applyPlan(plan: Plan, proposalId: string, operatorDid: string) {
  if (plan.operation === 'bulk-proxy') {
    for (const change of plan.changes) {
      await requireExecutingClaim(proposalId);
      if (!await isImportHuman(operatorDid) || !await controlsImportOwner(operatorDid, plan.ownerDid)) throw new Error('Unavailable');
      const authority = await freshAuthority(plan, 'cloudflare:dns');
      await patchDns(authority, change.recordId, { proxied: change.after.proxied }, proposalId, change.before);
    }
    return;
  }
  await requireExecutingClaim(proposalId);
  const authority = await freshAuthority(plan, 'cloudflare:cache');
  const before = await cacheRules(authority);
  if (canonicalize(before) !== canonicalize(plan.before)) throw new Error('Stale plan');
  await mutation(authority, 'cache.set', before, plan.rules,
    () => authority.client.request('/rulesets/phases/http_request_cache_settings/entrypoint',
      z.object({ rules: z.array(cacheRuleOutputSchema).max(20) }).strip(), 'PUT', { rules: plan.rules }), proposalId);
}

async function requireExecutingClaim(proposalId: string): Promise<void> {
  const [row] = await db.select({ id: operatorApprovals.proposalId }).from(operatorApprovals).where(and(
    eq(operatorApprovals.proposalId, proposalId), eq(operatorApprovals.status, 'approved'),
    eq(operatorApprovals.source, 'cloudflare'),
  )).limit(1);
  if (!row) throw new Error('Unavailable');
}

/** Atomic durable claim precedes the first mutation; partial failures are never replayable. */
export async function executeCloudflareApproval(card: OperatorApprovalCard): Promise<{ ok: boolean; error?: string }> {
  let claimedExecution = false;
  try {
    const plan = await verifyCard(card);
    const claimed = await db.update(operatorApprovals).set({
      outcome: { cloudflareClaimedAt: new Date().toISOString() }, updatedAt: new Date(),
    }).where(and(
      eq(operatorApprovals.proposalId, card.proposalId), eq(operatorApprovals.status, 'approved'),
      eq(operatorApprovals.contentHash, card.contentHash!),
      eq(operatorApprovals.operatorDid, card.operatorDid),
      eq(operatorApprovals.source, 'cloudflare'), eq(operatorApprovals.kind, card.kind),
      sql`${operatorApprovals.decision}->'payload' = ${JSON.stringify(card.decision)}::jsonb`,
      isNull(operatorApprovals.outcome),
    )).returning({ id: operatorApprovals.proposalId });
    if (claimed.length !== 1) throw new Error('Already claimed');
    claimedExecution = true;
    const authority = await freshAuthority(plan, plan.operation === 'bulk-proxy' ? 'cloudflare:dns' : 'cloudflare:cache');
    await mutation(authority, plan.operation, plan.operation === 'bulk-proxy' ? plan.changes.map(change => change.before) : plan.before,
      plan.operation === 'bulk-proxy' ? plan.changes.map(change => change.after) : plan.rules,
      async () => {
        await applyPlan(plan, card.proposalId, card.operatorDid);
        return { status: 'applied' };
      }, card.proposalId);
    await db.update(operatorApprovals).set({
      status: 'applied', appliedAt: new Date(), outcome: { cloudflareStatus: 'success' }, updatedAt: new Date(),
    }).where(eq(operatorApprovals.proposalId, card.proposalId));
    return { ok: true };
  } catch {
    if (claimedExecution) {
      await db.update(operatorApprovals).set({
        outcome: { cloudflareStatus: 'failed', requiresNewPlan: true }, updatedAt: new Date(),
      }).where(eq(operatorApprovals.proposalId, card.proposalId))
        .catch(() => log.error({ proposalId: card.proposalId }, 'Cloudflare execution outcome persistence unavailable'));
    }
    return { ok: false, error: 'Cloudflare execution unavailable or stale; inspect signed history and submit a new plan' };
  }
}
