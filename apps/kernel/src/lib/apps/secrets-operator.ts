/**
 * App self-secret operator rail (#2799). Proposals carry names/recipes only.
 * Execution requires a verified human signature, not a session or agent request.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, registryApps, appSigningKeyClaims, appProvisions, operatorApprovals, attestations } from '@/src/db';
import { appManifestError, fetchAppManifest, tryGetInstallationToken } from '@/src/lib/github/org-provisioning';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { resolveVaultAuthorization, type VaultAuthorization } from '@/src/lib/vault/authorization';
import { validateSecrets, type AppSecretDeclaration } from './secret-declarations';
import { rotateAppDeclaredSecret, revokeAppDeclaredSecret, listAppDeclaredSecrets, setAppDeclaredSecret } from './self-secrets';
import { appSecretsKind, isAppSecretsKind } from './secrets-kind';
import { consumeAppSecret } from './secret-staging';
import { getOperatorDid } from '@/src/lib/notify/operator-approvals';
import type { OperatorAppSecrets } from './secrets-metadata';
import { newSecretDeclarations } from './declarations-approval';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
function provenanceIdentity(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export function sameSecretDeclarations(a: AppSecretDeclaration[], b: AppSecretDeclaration[]): boolean {
  const canonical = (list: AppSecretDeclaration[]) => JSON.stringify([...list].sort((x, y) => x.name.localeCompare(y.name)));
  return canonical(a) === canonical(b);
}

/** One pending sync per app, including concurrent requests from multiple nodes. */
export async function withPendingSecretSync(
  appDid: string, operatorDid: string, create: () => Promise<string>,
): Promise<string> {
  return db.transaction(async (tx) => {
    // Fail fast rather than occupy connections needed by the approval service.
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`app-secret-sync:${appDid}`}, 0)) AS locked`,
    );
    if (!lock?.locked) throw new Error('App-secret sync busy');
    const [pending] = await tx.select({ proposalId: operatorApprovals.proposalId }).from(operatorApprovals)
      .where(and(eq(operatorApprovals.source, 'apps'), eq(operatorApprovals.kind, appSecretsKind('sync')),
        eq(operatorApprovals.operatorDid, operatorDid), eq(operatorApprovals.status, 'pending'),
        sql`${operatorApprovals.detail}->>'appDid' = ${appDid}`)).limit(1);
    return pending?.proposalId ?? await create();
  });
}

/** A manifest read failure must never be mistaken for an empty approved list. */
export async function previewAppSecrets(slug: string): Promise<{ ok: AppSecretDeclaration[] } | { error: string }> {
  try {
    const manifest = await fetchAppManifest(slug, await tryGetInstallationToken());
    if ('error' in manifest) return { error: appManifestError(slug, manifest) };
    const secrets = validateSecrets(manifest.ok.secrets);
    if ('error' in secrets) return { error: appManifestError(slug, { error: 'invalid' }) };
    return secrets;
  } catch {
    return { error: appManifestError(slug, { error: 'unreadable' }) };
  }
}

export async function hasClaimedApp(appDid: string): Promise<boolean> {
  const rows = await db.select({ appDid: appSigningKeyClaims.appDid }).from(appSigningKeyClaims)
    .where(and(eq(appSigningKeyClaims.appDid, appDid), eq(appSigningKeyClaims.status, 'claimed'),
      isNull(appSigningKeyClaims.bootstrapKeyRevokedAt)));
  return rows.length > 0;
}
async function secretMetadata(appDid: string) {
  return (await listAppDeclaredSecrets(appDid)).map(({ name, kind, status, timeline }) => ({
    name, kind, status,
    timeline: timeline.map(({ phase, at, operatorDid, via, grantId }) => ({
      phase, at, ...(operatorDid ? { operatorDid } : {}), ...(via ? { via } : {}), ...(grantId ? { grantId } : {}),
    })),
  }));
}

/** Registry membership alone is not evidence that an app can use self-secrets. */
export async function listOperatorAppSecrets(): Promise<OperatorAppSecrets[]> {
  const apps = await db.select({
    appDid: registryApps.appDid, slug: registryApps.slug, name: registryApps.name,
    createdAt: registryApps.createdAt, ownerDid: registryApps.ownerDid,
  }).from(registryApps).where(and(eq(registryApps.status, 'active'), sql`(
    exists (select 1 from ${appProvisions} where ${appProvisions.appDid} = ${registryApps.appDid})
    or exists (select 1 from ${appSigningKeyClaims} where ${appSigningKeyClaims.appDid} = ${registryApps.appDid})
  )`)).orderBy(asc(registryApps.name));
  const provisions = await db.select({
    appDid: appProvisions.appDid, slug: appProvisions.slug,
    status: appProvisions.status,
    createdAt: appProvisions.createdAt, registeredAt: appProvisions.registeredAt,
  }).from(appProvisions).orderBy(asc(appProvisions.slug));
  const dids = [...new Set([...apps, ...provisions].flatMap((app) => app.appDid ? [app.appDid] : []))];
  const claims = dids.length === 0 ? [] : await db.select({
    appDid: appSigningKeyClaims.appDid, status: appSigningKeyClaims.status,
    expiresAt: appSigningKeyClaims.expiresAt, claimedAt: appSigningKeyClaims.claimedAt,
    claimedByHost: appSigningKeyClaims.claimedByHost,
  }).from(appSigningKeyClaims).where(and(inArray(appSigningKeyClaims.appDid, dids),
    isNull(appSigningKeyClaims.bootstrapKeyRevokedAt))).orderBy(desc(appSigningKeyClaims.createdAt));
  const approvals = await db.select({
    slug: sql<string>`${operatorApprovals.detail}->>'slug'`,
    proposedBy: operatorApprovals.signerDid,
    approvedBy: sql<string | null>`${operatorApprovals.decision}->'payload'->>'decidedBy'`,
  }).from(operatorApprovals).where(and(
    eq(operatorApprovals.source, 'apps'), eq(operatorApprovals.kind, 'apps:provision'),
    eq(operatorApprovals.status, 'applied'),
    sql`${operatorApprovals.decision}->'payload'->>'decision' = 'approve'`,
    sql`coalesce(${operatorApprovals.detail}->>'reissueClaim', 'false') <> 'true'`,
  )).orderBy(asc(operatorApprovals.createdAt));
  const active = new Set(apps.map((app) => app.appDid));
  const entries = [
    ...apps.map((app) => ({ ...app, active: true })),
    ...provisions.filter((row) => !row.appDid || !active.has(row.appDid)).map((row) => ({
      appDid: row.appDid, slug: row.slug, name: row.slug, active: false, createdAt: null, ownerDid: null,
    })),
  ];
  return Promise.all(entries.map(async (app) => {
    const provision = provisions.find((row) => row.appDid === app.appDid && app.appDid !== null)
      ?? provisions.find((row) => row.slug === app.slug && !row.appDid);
    const approval = provision ? approvals.find((row) => row.slug === provision.slug) : undefined;
    const appClaims = claims.filter((row) => row.appDid === app.appDid);
    const claimed = appClaims.find((row) => row.status === 'claimed');
    const claim = claimed ?? appClaims[0];
    const liveCode = claim?.status === 'pending' && claim.expiresAt.getTime() > Date.now();
    const provisionFailed = !claimed && Boolean(provision)
      && (provision?.status === 'failed' || (provision?.status === 'pending' && !liveCode));
    const secrets = app.active && app.appDid ? await secretMetadata(app.appDid) : [];
    const fetched = secrets.flatMap((secret) => secret.timeline).filter((entry) => entry.phase === 'fetched')
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return {
      appDid: app.appDid, slug: app.slug, name: app.name, active: app.active, claimed: Boolean(claimed),
      claimExpiresAt: claim?.expiresAt.toISOString() ?? null,
      provisionFailed,
      provenance: {
        created: { at: app.createdAt?.toISOString() ?? null, by: provenanceIdentity(app.ownerDid) },
        provisioned: {
          at: (provision?.registeredAt ?? provision?.createdAt)?.toISOString() ?? null,
          proposedBy: provenanceIdentity(approval?.proposedBy), approvedBy: provenanceIdentity(approval?.approvedBy),
        },
        claimed: { at: claimed?.claimedAt?.toISOString() ?? null, by: provenanceIdentity(claimed?.claimedByHost) },
        lastSeen: { at: fetched?.at ?? null, by: fetched ? app.appDid : null },
      },
      secrets,
    };
  }));
}

export type AppSecretsExecutionResult =
  | { ok: true; data: { appDid: string; action: string; names: string[] } }
  | { ok: false; error: string };
async function executeSync(
  appDid: string,
  app: { slug: string | null },
  current: AppSecretDeclaration[],
  detail: Record<string, unknown> | null,
  authorizedBy: VaultAuthorization,
): Promise<AppSecretsExecutionResult> {
  if (!app.slug || app.slug !== detail?.slug) return { ok: false, error: 'App manifest source has changed' };
  if (!Array.isArray(detail?.secrets)) return { ok: false, error: 'Missing approved secret snapshot' };
  const approved = validateSecrets(detail.secrets);
  if ('error' in approved) return { ok: false, error: approved.error };
  const actual = await previewAppSecrets(app.slug);
  if ('error' in actual) return { ok: false, error: actual.error };
  if (approved.ok.some((secret) => !actual.ok.some((entry) => entry.name === secret.name && entry.kind === secret.kind))) {
    return { ok: false, error: 'App manifest secrets changed since proposal; propose again' };
  }
  if (approved.ok.some((secret) => current.some((old) => old.name === secret.name && old.kind !== secret.kind))) {
    return { ok: false, error: 'An existing secret generation kind cannot be changed by sync' };
  }
  const { additions } = newSecretDeclarations(current, approved.ok);
  if (additions.length === 0) return { ok: true, data: { appDid, action: 'sync', names: [] } };
  const merged = validateSecrets([...current, ...additions]);
  if ('error' in merged) return { ok: false, error: merged.error };
  const attestation = await prepareMechanicalAttestation({
    subjectDid: appDid, type: 'apps.secrets.declarations-refreshed', contextId: appDid, contextType: 'app',
    payload: { appDid, additions, authorizedBy },
  });
  await db.transaction(async (tx) => {
    // CAS preserves concurrent additions; no identity, key, claim or timestamp writes.
    const updated = await tx.update(registryApps).set({ secrets: merged.ok }).where(and(
      eq(registryApps.appDid, appDid), eq(registryApps.status, 'active'), eq(registryApps.slug, app.slug!),
      sql`coalesce(${registryApps.secrets}, '[]'::jsonb) = ${JSON.stringify(current)}::jsonb`,
    )).returning({ appDid: registryApps.appDid });
    if (updated.length === 0) throw new Error('Registered declarations changed; propose again');
    await tx.insert(attestations).values(attestation);
  });
  return { ok: true, data: { appDid, action: 'sync', names: additions.map((secret) => secret.name) } };
}

async function executeNamedSecret(
  card: OperatorApprovalCard, appDid: string, declarations: AppSecretDeclaration[], authorizedBy: VaultAuthorization,
): Promise<AppSecretsExecutionResult> {
  const name = card.detail?.name;
  const declaration = declarations.find((secret) => secret.name === name);
  if (typeof name !== 'string' || !declaration) return { ok: false, error: 'Secret is not declared for this app' };
  const action = card.kind === appSecretsKind('set') ? 'set' : 'rotate';
  if (card.kind === appSecretsKind('set') || (card.kind === appSecretsKind('rotate') && declaration.kind === 'operator-supplied')) {
    if (declaration.kind !== 'operator-supplied' || typeof card.detail?.stagingRef !== 'string'
      || authorizedBy.operatorDid !== await getOperatorDid()) {
      return { ok: false, error: 'App-secret operator input unavailable' };
    }
    const value = await consumeAppSecret(card.detail.stagingRef, {
      proposalId: authorizedBy.approvalId, operatorDid: authorizedBy.operatorDid, appDid, name, action,
    });
    await setAppDeclaredSecret(appDid, name, action, value, authorizedBy);
  } else if (card.kind === appSecretsKind('rotate')) {
    await rotateAppDeclaredSecret(appDid, name, authorizedBy);
  } else {
    await revokeAppDeclaredSecret(appDid, name, authorizedBy);
  }
  return { ok: true, data: { appDid, action: card.kind === appSecretsKind('revoke') ? 'revoke' : action, names: [name] } };
}

export async function executeAppSecretsApproval(card: OperatorApprovalCard): Promise<AppSecretsExecutionResult> {
  const authorizedBy = resolveVaultAuthorization(card);
  if (!authorizedBy) return { ok: false, error: `${card.kind} requires a countersigned operator decision` };
  if (card.status !== 'approved' || card.decision?.decision !== 'approve') {
    return { ok: false, error: 'App secrets require an approved operator decision' };
  }
  if (card.source !== 'apps' || !isAppSecretsKind(card.kind)) return { ok: false, error: 'Unrecognized app-secret proposal kind' };
  const appDid = card.detail?.appDid;
  if (typeof appDid !== 'string' || !appDid) return { ok: false, error: 'App-secret proposal is missing appDid' };
  try {
    const [app] = await db.select({
      status: registryApps.status, slug: registryApps.slug, secrets: registryApps.secrets,
    }).from(registryApps).where(eq(registryApps.appDid, appDid));
    if (app?.status !== 'active' || !(await hasClaimedApp(appDid))) {
      return { ok: false, error: 'App must be active and claimed' };
    }
    const current = validateSecrets(app.secrets ?? []);
    if ('error' in current) return { ok: false, error: 'Registered secret declarations are invalid' };
    if (card.kind === appSecretsKind('sync')) {
      return await executeSync(appDid, app, current.ok, card.detail, authorizedBy);
    }
    return await executeNamedSecret(card, appDid, current.ok, authorizedBy);
  } catch {
    // Provider errors may contain credential material; never log or surface them.
    return { ok: false, error: 'App-secret execution failed' };
  }
}
