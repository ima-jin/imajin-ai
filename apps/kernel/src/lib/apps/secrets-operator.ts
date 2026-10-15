/**
 * App self-secret operator rail (#2799). Proposals carry names/recipes only.
 * Execution requires a verified human signature, not a session or agent request.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db, registryApps, appSigningKeyClaims, appProvisions } from '@/src/db';
import { appManifestError, fetchAppManifest, tryGetInstallationToken } from '@/src/lib/github/org-provisioning';
import type { OperatorApprovalCard } from '@/src/lib/notify/operator-approvals-service';
import { resolveVaultAuthorization, type VaultAuthorization } from '@/src/lib/vault/authorization';
import { validateSecrets, type AppSecretDeclaration } from './secret-declarations';
import { ensureAppDeclaredSecrets, rotateAppDeclaredSecret, revokeAppDeclaredSecret, listAppDeclaredSecrets } from './self-secrets';
import { appSecretsKind, isAppSecretsKind } from './secrets-kind';

export function sameSecretDeclarations(a: AppSecretDeclaration[], b: AppSecretDeclaration[]): boolean {
  const canonical = (list: AppSecretDeclaration[]) => JSON.stringify([...list].sort((x, y) => x.name.localeCompare(y.name)));
  return canonical(a) === canonical(b);
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

/** Include registry apps even when there is no provision ledger (older claims). */
export async function listOperatorAppSecrets() {
  const apps = await db.select({
    appDid: registryApps.appDid, slug: registryApps.slug, name: registryApps.name,
  }).from(registryApps).where(eq(registryApps.status, 'active')).orderBy(asc(registryApps.name));
  const provisions = await db.select({
    appDid: appProvisions.appDid, slug: appProvisions.slug,
  }).from(appProvisions).where(eq(appProvisions.status, 'succeeded')).orderBy(asc(appProvisions.slug));
  const dids = apps.map((app) => app.appDid);
  const claims = dids.length === 0 ? [] : await db.select({ appDid: appSigningKeyClaims.appDid })
    .from(appSigningKeyClaims).where(and(inArray(appSigningKeyClaims.appDid, dids),
      eq(appSigningKeyClaims.status, 'claimed'), isNull(appSigningKeyClaims.bootstrapKeyRevokedAt)));
  const claimed = new Set(claims.map((claim) => claim.appDid));
  const active = new Set(dids);
  const registered = await Promise.all(apps.map(async (app) => ({
    ...app, claimed: claimed.has(app.appDid), active: true,
    secrets: await secretMetadata(app.appDid),
  })));
  return [
    ...registered,
    ...provisions.filter((row) => !row.appDid || !active.has(row.appDid)).map((row) => ({
      ...row, name: row.slug, claimed: false, active: false, secrets: [],
    })),
  ];
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
  if (!sameSecretDeclarations(actual.ok, approved.ok)) return { ok: false, error: 'App manifest secrets changed since proposal; propose again' };
  if (approved.ok.some((secret) => current.some((old) => old.name === secret.name && old.kind !== secret.kind))) {
    return { ok: false, error: 'An existing secret generation kind cannot be changed by sync' };
  }
  // Deliberately never writes providesScopes, dependsOn, or emittableEvents.
  await db.update(registryApps).set({ secrets: approved.ok }).where(and(
    eq(registryApps.appDid, appDid), eq(registryApps.status, 'active'),
  ));
  await ensureAppDeclaredSecrets(appDid, authorizedBy);
  return { ok: true, data: { appDid, action: 'sync', names: approved.ok.map((secret) => secret.name) } };
}

export async function executeAppSecretsApproval(card: OperatorApprovalCard): Promise<AppSecretsExecutionResult> {
  const authorizedBy = resolveVaultAuthorization(card);
  if (!authorizedBy) return { ok: false, error: `${card.kind} requires a countersigned operator decision` };
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
    const name = card.detail?.name;
    if (typeof name !== 'string' || !current.ok.some((secret) => secret.name === name)) {
      return { ok: false, error: 'Secret is not declared for this app' };
    }
    if (card.kind === appSecretsKind('rotate')) {
      await rotateAppDeclaredSecret(appDid, name, authorizedBy);
    } else {
      await revokeAppDeclaredSecret(appDid, name, authorizedBy);
    }
    return { ok: true, data: { appDid, action: card.kind === appSecretsKind('rotate') ? 'rotate' : 'revoke', names: [name] } };
  } catch {
    // Provider errors may contain credential material; never log or surface them.
    return { ok: false, error: 'App-secret execution failed' };
  }
}
