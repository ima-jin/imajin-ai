import { NextResponse, NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { and, eq, sql } from 'drizzle-orm';
import { db, vaultDelegationGrants } from '@/src/db';
import { _applyDelegationGrant, loadAndUnseal, vaultService } from '@/src/lib/vault';
import { getNodeSigningIdentity, getNodeXPrivateKey } from '@/src/lib/vault/sealing';
import { listModels, probeModel } from '@/src/lib/anthropic/model-handlers';
import { setModelId } from '@/src/lib/anthropic/connector';
import { sealBillingKey, billingKeySealed, billingKeyPending, revokeBillingKey } from '@/src/lib/anthropic/billing-connector';
import * as scopes from '@/app/anthropic/api/scope-manifest/route';
import * as environment from '@/app/warp/api/environment/route';
import { corsHeaders } from './cors';
import { createConnectorModelPickerRoute } from './connector-model-picker-route';
import { createConnectorTokenRoutes } from './connector-token-route';
import { ExternalMcpError } from './external-mcp-policy';
import { authorizeOrgConnectionAdmin, isOrgSealedAnthropicField, type OrgConnectionActor } from './org-held-connection-policy';
import { findMemberConnection, hasOrgConnectionProvenance, isLiveConnection } from './member-connection-gate';
import { isExternalMcpField } from '@/src/lib/vault/field-grammar';
import { readConnectorRegistration } from './connector-registry-store';
import { resolveOrgSealProvenance } from './org-seal-provenance';
import { isAgentCapableSubtype } from './connection-principal-policy';
import { externalConnectionBody } from './external-mcp-route';

/** A management surface, not a new member/runtime credential authority. */
async function requireManager(request: NextRequest): Promise<OrgConnectionActor> {
  const auth = await requireAuth(request, { sessionOnly: true, service: 'connections' });
  if ('error' in auth) throw new ExternalMcpError(auth.status, 'Organization admin session required');
  const person = auth.identity;
  if (!person.actingAs || person.actingFor || isAgentCapableSubtype(person.subtype)
    || !['owner', 'admin'].includes(person.actingAsRole ?? '')
    || request.headers.has('x-app-did') || request.headers.has('x-app-authorization')
    || request.headers.has('x-acting-for') || request.headers.has('authorization')) {
    throw new ExternalMcpError(403, 'Organization admin act-as required');
  }
  const actor = { actorDid: person.id, orgDid: resolveActingDid(person) };
  await db.transaction(tx => authorizeOrgConnectionAdmin(tx, actor));
  return actor;
}

/** Use exactly the loaded org row; never fall back to the human's or a legacy key. */
export function loadOrgPickerCredentials(actor: OrgConnectionActor) {
  return db.transaction(async tx => {
    const lock = `org-held-connection:${actor.orgDid}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    await authorizeOrgConnectionAdmin(tx, actor);
    const row = await findMemberConnection(tx, actor.orgDid, 'anthropic', true);
    if (!row || !isLiveConnection(row) || !hasOrgConnectionProvenance(row) || !row.sealedKeyField
      || !(isExternalMcpField(row.sealedKeyField) || isOrgSealedAnthropicField(actor.orgDid, row.sealedKeyField))) {
      return undefined;
    }
    const node = getNodeSigningIdentity();
    const [grant] = await tx.select().from(vaultDelegationGrants).where(and(
      eq(vaultDelegationGrants.field, row.sealedKeyField), eq(vaultDelegationGrants.subject, actor.orgDid),
      eq(vaultDelegationGrants.grantedTo, node.senderDid), eq(vaultDelegationGrants.status, 'active'),
    )).limit(1).for('share');
    if (!grant || !isLiveConnection(grant) || grant.oneTime) return undefined;
    const entry = await vaultService.get(row.sealedKeyField);
    if (!entry || entry.deleted || entry.senderPubkey !== node.senderPubkey
      || entry.custodyScheme !== 'delegation-grant') return undefined;
    const apiKey = await _applyDelegationGrant(entry, grant, getNodeXPrivateKey(), node.senderPubkey);
    const modelId = await loadAndUnseal(`anthropic-model-id:${actor.orgDid}`);
    return { apiKey, ...(modelId ? { modelId } : {}) };
  });
}

function billingHandlers(request: NextRequest) {
  return createConnectorTokenRoutes({
    name: 'Anthropic Billing',
    sealApiKey: sealBillingKey,
    orgSealProvenance: (_request, ownerDid) => resolveOrgSealProvenance(request, ownerDid),
    keySealed: async ownerDid => {
      const row = await readConnectorRegistration(ownerDid, 'anthropic-billing');
      return !!row && isLiveConnection(row) && hasOrgConnectionProvenance(row) && !!row.sealedKeyField
        && await billingKeySealed(ownerDid);
    },
    keyPending: billingKeyPending,
    revokeApiKey: revokeBillingKey,
  });
}

type Handler = (request: NextRequest) => Promise<NextResponse>;

async function managementRequest(request: NextRequest) {
  if (!['POST', 'PUT'].includes(request.method)) return request;
  const raw = await externalConnectionBody(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExternalMcpError(400, 'JSON object body required');
  }
  return new NextRequest(request.url, {
    method: request.method, headers: request.headers, body: JSON.stringify(raw),
  });
}

async function dispatch(request: NextRequest, actor: OrgConnectionActor, provider: string, section: string) {
  let handlers: { GET?: Handler; POST?: Handler; PUT?: Handler; DELETE?: Handler };
  if (provider === 'anthropic' && section === 'models') {
    handlers = createConnectorModelPickerRoute({
      id: 'anthropic', displayName: 'Anthropic',
      loadSealedCredentials: () => loadOrgPickerCredentials(actor),
      keyPending: () => Promise.resolve(false),
      setModelId: async (_ownerDid, modelId) => {
        try { await setModelId(actor.orgDid, modelId); }
        catch { throw new Error('Organization model default unavailable'); }
      },
      listModels,
      probeModel: async (credentials, modelId) => {
        try { return await probeModel(credentials, modelId); }
        catch { throw new Error('Organization model probe unavailable'); }
      },
    });
  } else if (provider === 'anthropic' && section === 'billing-key') {
    handlers = billingHandlers(request);
  } else if (provider === 'anthropic' && section === 'scopes') {
    handlers = scopes;
  } else if (provider === 'warp' && section === 'settings') {
    handlers = environment;
  } else {
    throw new ExternalMcpError(404, 'Org-held section unavailable');
  }
  const handler = handlers[request.method as keyof typeof handlers];
  if (!handler) throw new ExternalMcpError(405, 'Method not allowed');
  const response = await handler(request);
  if (provider !== 'anthropic' || section !== 'billing-key' || request.method !== 'GET' || !response.ok) return response;
  const data = await response.json();
  const row = await readConnectorRegistration(actor.orgDid, 'anthropic-billing');
  return NextResponse.json({
    keySealed: data.keySealed === true, credentialPending: data.credentialPending === true,
    ...(data.keySealed && row ? { loadedByDid: row.loadedByDid, loadedAt: row.loadedAt } : {}),
  });
}

export async function orgProviderManagement(request: NextRequest, provider: string, section: string) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    const actor = await requireManager(request);
    const response = await dispatch(await managementRequest(request), actor, provider, section);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch (error) {
    return NextResponse.json({
      error: error instanceof ExternalMcpError ? error.message : 'Organization provider section unavailable',
    }, { status: error instanceof ExternalMcpError ? error.status : 503, headers });
  }
}
