/**
 * App self-secrets use kernel custody and exactly one app-DID grant (#2799).
 * No parallel vault: generation, claim concurrency, sealing, regrant on rotate
 * and crypto-erasure all delegate to the internal-secret primitives.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { emitMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { db, registryApps, vaultDelegationGrants, attestations } from '@/src/db';
import { getNodeSigningIdentity, isVaultTier1 } from '@/src/lib/vault/sealing';
import { getOrGenerateInternalSecret, internalSecretField } from '@/src/lib/vault/internal-secret';
import { grantInternalSecretTo } from '@/src/lib/vault/shared-internal-secret';
import { rotateInternalSecret } from '@/src/lib/vault/internal-secret-rotate';
import { revokeInternalSecret } from '@/src/lib/vault/internal-secret-revoke';
import { fetchGrantSecret } from '@/src/lib/vault';
import type { VaultAuthorization } from '@/src/lib/vault/authorization';
import { APP_SECRET_KINDS, validateSecrets, type AppSecretDeclaration } from './secret-declarations';

type Phase = 'minted' | 'granted' | 'fetched' | 'rotated' | 'revoked';
export interface AppSecretTimelineEntry {
  phase: Phase;
  at: string;
  operatorDid?: string;
  via?: string;
  grantId?: string;
}
async function ensureAppGrant(appDid: string, name: string): Promise<string> {
  try {
    const grant = await grantInternalSecretTo(appSecretPurpose(appDid, name), appDid, getNodeSigningIdentity().senderDid);
    if (grant.status !== 'ok') throw new Error('App secret grant unavailable');
    return grant.grantId;
  } catch (error) {
    // Two issuers may reach the external grant after sharing the generation
    // winner. The DB unique constraint chooses one; a loser adopts that grant.
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '23505') throw error;
    const winner = (await grantsForSecret(appDid, name)).find((grant) => grant.status === 'active');
    if (!winner) throw new Error('App secret grant unavailable');
    return winner.id;
  }
}
export interface AppDeclaredSecretStatus extends AppSecretDeclaration {
  status: 'missing' | 'active' | 'revoked';
  timeline: AppSecretTimelineEntry[];
}

export function appSecretPurpose(appDid: string, name: string): string {
  return `app-self:${appDid}:${name}`;
}

async function declarationsForApp(appDid: string): Promise<AppSecretDeclaration[]> {
  const [app] = await db.select({ status: registryApps.status, secrets: registryApps.secrets })
    .from(registryApps).where(eq(registryApps.appDid, appDid)).limit(1);
  if (app?.status !== 'active') throw new Error('App secret access refused');
  const parsed = validateSecrets(app.secrets ?? []);
  if ('error' in parsed) throw new Error('App secret declarations invalid');
  return parsed.ok;
}

async function requireDeclaration(appDid: string, name: string): Promise<AppSecretDeclaration> {
  const declared = (await declarationsForApp(appDid)).find((secret) => secret.name === name);
  if (!declared) throw new Error('App secret access refused');
  return declared;
}

/** Scope every lookup to this kernel AND this app AND this declared purpose. */
async function grantsForSecret(appDid: string, name: string) {
  const purpose = appSecretPurpose(appDid, name);
  return db.select().from(vaultDelegationGrants).where(and(
    eq(vaultDelegationGrants.subject, getNodeSigningIdentity().senderDid),
    eq(vaultDelegationGrants.grantedTo, appDid),
    eq(vaultDelegationGrants.purpose, purpose),
    eq(vaultDelegationGrants.field, internalSecretField(purpose)),
  ));
}

/** Node-signed metadata only; failures surface without leaking provider errors. */
async function recordPhase(
  appDid: string, name: string, phase: Phase, grantId?: string, authorizedBy?: VaultAuthorization,
): Promise<void> {
  try {
    const attestationId = await emitMechanicalAttestation({
      subjectDid: appDid,
      type: 'apps.secret.lifecycle',
      contextId: appSecretPurpose(appDid, name),
      contextType: 'app-self-secret',
      payload: { appDid, name, phase, ...(grantId ? { grantId } : {}), ...(authorizedBy ? { authorizedBy } : {}) },
    });
    if (!attestationId) throw new Error('App secret audit unavailable');
  } catch {
    throw new Error('App secret audit unavailable');
  }
}

function requireSupportedCustody(): void {
  if (isVaultTier1()) throw new Error('App self-secrets require Tier 0 vault custody');
}

async function recordIssuance(appDid: string, name: string, grantId: string, authorizedBy?: VaultAuthorization): Promise<void> {
  const facts = await db.select({ payload: attestations.payload }).from(attestations).where(and(
    eq(attestations.issuerDid, getNodeSigningIdentity().senderDid),
    eq(attestations.subjectDid, appDid),
    eq(attestations.type, 'apps.secret.lifecycle'),
    eq(attestations.contextId, appSecretPurpose(appDid, name)),
  )).orderBy(asc(attestations.issuedAt));
  for (const phase of ['minted', 'granted'] as const) {
    const recorded = facts.some((fact) => {
      const payload = fact.payload as Record<string, unknown> | null;
      return payload?.grantId === grantId && payload.phase === phase;
    });
    if (!recorded) await recordPhase(appDid, name, phase, grantId, authorizedBy);
  }
}

/** Issue only missing recipes; revoked grants are durable withdrawal tombstones. */
export async function ensureAppDeclaredSecrets(appDid: string, authorizedBy?: VaultAuthorization): Promise<void> {
  const declarations = await declarationsForApp(appDid);
  if (declarations.length === 0) return;
  requireSupportedCustody();
  for (const secret of declarations) {
    const grants = await grantsForSecret(appDid, secret.name);
    const active = grants.find((grant) => grant.status === 'active');
    if (active) {
      await recordIssuance(appDid, secret.name, active.id, authorizedBy);
      continue;
    }
    if (grants.some((grant) => grant.status === 'revoked')) continue;
    const purpose = appSecretPurpose(appDid, secret.name);
    await getOrGenerateInternalSecret(purpose, () => randomBytes(APP_SECRET_KINDS[secret.kind]).toString('hex'));
    const grantId = await ensureAppGrant(appDid, secret.name);
    await recordIssuance(appDid, secret.name, grantId, authorizedBy);
  }
}

/** Called only after keystore proof-of-possession; never used as an HTTP response. */
export async function fetchAppDeclaredSecret(appDid: string, name: string): Promise<{ value: string; grantId: string; field: string }> {
  await requireDeclaration(appDid, name);
  const grant = (await grantsForSecret(appDid, name)).find((candidate) => candidate.status === 'active');
  if (!grant) throw new Error('App secret access refused');
  const outcome = await fetchGrantSecret({ grantId: grant.id, granteeDid: appDid });
  if (outcome.status !== 'ok') throw new Error('App secret access refused');
  await recordPhase(appDid, name, 'fetched', grant.id);
  return { value: outcome.value, grantId: grant.id, field: grant.field };
}

export async function rotateAppDeclaredSecret(appDid: string, name: string, authorizedBy: VaultAuthorization): Promise<void> {
  const declaration = await requireDeclaration(appDid, name);
  requireSupportedCustody();
  if (!(await grantsForSecret(appDid, name)).some((grant) => grant.status === 'active')) {
    throw new Error('App secret is not active');
  }
  const purpose = appSecretPurpose(appDid, name);
  await rotateInternalSecret(internalSecretField(purpose), randomBytes(APP_SECRET_KINDS[declaration.kind]).toString('hex'));
  const grant = (await grantsForSecret(appDid, name)).find((candidate) => candidate.status === 'active');
  if (!grant) throw new Error('App secret replacement grant unavailable');
  await recordPhase(appDid, name, 'minted', grant.id, authorizedBy);
  await recordPhase(appDid, name, 'granted', grant.id, authorizedBy);
  await recordPhase(appDid, name, 'rotated', grant.id, authorizedBy);
}

export async function revokeAppDeclaredSecret(appDid: string, name: string, authorizedBy: VaultAuthorization): Promise<void> {
  await requireDeclaration(appDid, name);
  requireSupportedCustody();
  await revokeInternalSecret(appSecretPurpose(appDid, name), { revokeExternal: true });
  await recordPhase(appDid, name, 'revoked', undefined, authorizedBy);
}

/** Value-free projection: whitelisted signed facts, not generic payloads or vault entries. */
export async function listAppDeclaredSecrets(appDid: string): Promise<AppDeclaredSecretStatus[]> {
  const declared = await declarationsForApp(appDid);
  return Promise.all(declared.map(async (secret) => {
    const grants = await grantsForSecret(appDid, secret.name);
    const facts = await db.select({ payload: attestations.payload, issuedAt: attestations.issuedAt })
      .from(attestations).where(and(
        eq(attestations.issuerDid, getNodeSigningIdentity().senderDid),
        eq(attestations.subjectDid, appDid),
        eq(attestations.type, 'apps.secret.lifecycle'),
        eq(attestations.contextId, appSecretPurpose(appDid, secret.name)),
      )).orderBy(asc(attestations.issuedAt));
    const timeline = facts.flatMap((fact) => timelineEntry(fact.payload as Record<string, unknown> | null, fact.issuedAt));
    const status = grants.some((grant) => grant.status === 'active') ? 'active'
      : grants.some((grant) => grant.status === 'revoked') ? 'revoked' : 'missing';
    return { ...secret, status, timeline };
  }));
}

function timelineEntry(payload: Record<string, unknown> | null, issuedAt: Date): AppSecretTimelineEntry[] {
  const phase = payload?.phase;
  if (phase !== 'minted' && phase !== 'granted' && phase !== 'fetched' && phase !== 'rotated' && phase !== 'revoked') return [];
  const auth = payload?.authorizedBy as Partial<VaultAuthorization> | undefined;
  return [{
    phase, at: issuedAt.toISOString(),
    ...(typeof payload?.grantId === 'string' ? { grantId: payload.grantId } : {}),
    ...(typeof auth?.operatorDid === 'string' ? { operatorDid: auth.operatorDid } : {}),
    ...(typeof auth?.approvalId === 'string' ? { via: auth.approvalId } : {}),
  }];
}
