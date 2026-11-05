import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { SCOPE_VOCABULARY } from '@imajin/auth/scope-vocabulary';
import { db, registryApps, identities, identityMembers, agentProvisions, attestations } from '@/src/db';
import { didFromPublicKey } from './crypto';
import { upsertAppAuthorization } from './upsert-app-authorization';
import { isLiveAppAuthorization } from './live-app-authorization';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Reserved .invalid domain: absolute URL accepted by registration, never routable. */
export const AGENT_CALLBACK_URL = 'https://agent.invalid/callback';
const inferenceScopes = new Set(['infer:completions', 'infer:usage-read']);
export const AGENT_APP_SCOPES = SCOPE_VOCABULARY.map(entry => entry.scope)
  .filter(scope => inferenceScopes.has(scope));

interface AgentAppInput {
  agentDid: string;
  publicKey: string;
  ownerDid: string;
  name: string;
  privateKey: string;
}

/** Insert-only: a hand-made registration is authoritative, even if inactive. */
export async function registerAgentApp(input: AgentAppInput, tx: Transaction) {
  if (didFromPublicKey(input.publicKey) !== input.agentDid) {
    throw new Error('Agent public key does not match its DID');
  }
  const [inserted] = await tx.insert(registryApps).values({
    id: `app_${nanoid(16)}`,
    appDid: input.agentDid, publicKey: input.publicKey, ownerDid: input.ownerDid,
    name: input.name, visibility: 'internal', signInAudience: 'members',
    callbackUrl: AGENT_CALLBACK_URL, redirectUris: [AGENT_CALLBACK_URL],
    allowedRedirectHosts: [new URL(AGENT_CALLBACK_URL).origin],
    requestedScopes: [...AGENT_APP_SCOPES], providesScopes: [], tier: 'third_party',
  }).onConflictDoNothing({ target: registryApps.appDid }).returning();
  const [app] = inserted ? [inserted] : await tx.select().from(registryApps)
    .where(eq(registryApps.appDid, input.agentDid)).limit(1);
  if (!app) throw new Error('Agent app registration unavailable');
  if (inserted) {
    const issuedAt = Date.now();
    const payload = { ownerDid: input.ownerDid, delegatorDid: input.ownerDid, source: 'agent-app' };
    const proof = {
      subject_did: input.agentDid, type: 'registry.app.registered',
      context_id: app.id, context_type: 'registry_app', payload, issued_at: issuedAt,
    };
    await tx.insert(attestations).values({
      id: `att_${nanoid(16)}`, issuerDid: input.agentDid, subjectDid: input.agentDid,
      type: proof.type, contextId: app.id, contextType: proof.context_type,
      payload, issuedAt: new Date(issuedAt), signature: authCrypto.signSync(canonicalize(proof), input.privateKey),
    });
  }
  return app;
}

/** Shared consent lock also serializes against plugin-side self-authorization. */
export async function authorizeAgentApp(input: AgentAppInput, tx: Transaction) {
  const app = await registerAgentApp(input, tx);
  if (app.status !== 'active') return;
  const requested = new Set(app.requestedScopes ?? []);
  await upsertAppAuthorization({
    ownerDid: input.agentDid, appDid: input.agentDid, appId: app.id,
    callbackUrl: app.callbackUrl,
    scopes: AGENT_APP_SCOPES.filter(scope => requested.has(scope)),
    privateKey: input.privateKey, delegatorDid: input.ownerDid, onlyIfMissing: true,
  }, tx);
}

async function agentOwner(agentDid: string, tx: Transaction): Promise<string | null> {
  // Provision is canonical for organization agents, which have no memberships.
  const provisions = await tx.select({ did: agentProvisions.servingDid }).from(agentProvisions)
    .where(eq(agentProvisions.agentDid, agentDid));
  const adoptions = await tx.select({ payload: attestations.payload }).from(attestations).where(and(
    eq(attestations.subjectDid, agentDid), eq(attestations.type, 'agent.adopted'), isNull(attestations.revokedAt),
  ));
  const adoptedOwners = adoptions.flatMap(row => {
    const orgDid = (row.payload as { orgDid?: unknown } | null)?.orgDid;
    return typeof orgDid === 'string' && orgDid ? [{ did: orgDid }] : [];
  });
  const recorded = provisions.length > 0 ? provisions : adoptedOwners;
  const owners = recorded.length > 0 ? recorded : await tx.select({ did: identityMembers.memberDid })
    .from(identityMembers).where(and(eq(identityMembers.identityDid, agentDid),
      eq(identityMembers.role, 'owner'), isNull(identityMembers.removedAt)));
  const dids = new Set(owners.map(owner => owner.did));
  return dids.size === 1 ? [...dids][0] : null;
}

async function backfillAgent(agent: typeof identities.$inferSelect, privateKey: string, tx: Transaction) {
  if (agent.suspendedAt) return 'suspended-agent';
  const [existing] = await tx.select().from(registryApps)
    .where(eq(registryApps.appDid, agent.id)).limit(1);
  const grants = await tx.select().from(attestations).where(and(
    eq(attestations.issuerDid, agent.id), eq(attestations.subjectDid, agent.id),
    eq(attestations.type, 'app.authorized'),
  ));
  if (existing && grants.some(grant => isLiveAppAuthorization(grant))) return 'already-registered';
  if (existing && existing.status !== 'active') return 'inactive-app';
  if (!/^[a-f0-9]{64}$/i.test(agent.publicKey) || didFromPublicKey(agent.publicKey) !== agent.id) return 'invalid-agent-key';
  if (existing && existing.publicKey !== agent.publicKey) return 'registry-key-mismatch';
  const ownerDid = existing?.ownerDid ?? await agentOwner(agent.id, tx);
  if (!ownerDid) return 'ambiguous-or-missing-owner';
  await authorizeAgentApp({
    agentDid: agent.id, publicKey: agent.publicKey, ownerDid,
    name: agent.name ?? agent.handle ?? agent.id, privateKey,
  }, tx);
  return null;
}

/** Server-attested consent, like /api/auth/authorize; no agent private keys are loaded. */
export async function backfillAgentApps(privateKey: string) {
  const agents = await db.select().from(identities)
    .where(and(eq(identities.scope, 'actor'), eq(identities.subtype, 'agent')));
  const results: Array<{ agentDid: string; status: 'registered' | 'skipped'; reason?: string }> = [];
  for (const agent of agents) {
    const result = await db.transaction(tx => backfillAgent(agent, privateKey, tx));
    results.push({ agentDid: agent.id, status: result ? 'skipped' : 'registered', ...(result ? { reason: result } : {}) });
  }
  return results;
}
