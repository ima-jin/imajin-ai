/**
 * `apps.provision` (#2375) — gate 1+2 of epic #2370: one kernel-authoritative
 * call that creates an extracted app's GitHub repo, registers it in the
 * existing `registry.apps` table (#1990) as a `tier: 'third_party'` row
 * (retiring a seeded legacy slug holder atomically — see `registerApp`'s
 * docblock), and vault-seals its app-auth private
 * key, handing the app a one-time claim code to fetch it at first boot.
 *
 * ## Idempotency + fail-closed (`kernel.app_provisions`)
 * One durable row per `slug`. A `status: 'succeeded'` row means "re-run
 * returns the existing repo/DID, does not re-create" — the pipeline below
 * short-circuits before touching GitHub or the registry again (though it
 * still seeds any NEWLY requested `attestationTypes`, which is additive).
 * A `status: 'failed'` row names the step that failed
 * (`failedStep`/`errorMessage`) and is safely retryable: every step checks
 * its own completion state first (repo: GET-before-create; mint: reuse the
 * ledger's own `appDid` once minting first succeeds, an existing
 * `vault_minted_keys` row for it; register: insert-if-not-already-registered
 * by that same appDid, never an upsert), so a retry only re-attempts
 * whatever didn't already succeed.
 *
 * ## No half-registered app is ever servable
 * The `registry.apps` row (the thing that makes an app "servable" —
 * `resolveActiveAppByAudience`/`isAppDidActive`) is written only AFTER a
 * real Ed25519 keypair already exists and is durably vault-sealed (steps
 * 1-2 succeed first) — never with a placeholder key.
 *
 * ## Credential custody (#2437)
 * The minted app private key is generated in-process and immediately sealed
 * into the vault (self-granted to the node — see `ensureMintedKeypair`). It
 * never leaves the vault/keystore path: this module never unseals it, and it
 * is NEVER copied into an env file or a GitHub Actions secret (sealing it as
 * `IMAJIN_APP_PRIVATE_KEY` was removed in #2437; apps refuse to boot when that
 * env var is set, #2411). The app fetches its key at boot via the one-time
 * claim code (`signing-key-claims.ts`). `AppProvisionSuccess.secretsSet` is
 * kept for API/ledger compatibility and is always an empty list for new
 * runs. The GitHub credential used to reach the repo is a GitHub App
 * installation token (#2416) — see `org-provisioning.ts`'s docblock —
 * never a PAT.
 */
import { and, arrayContains, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, appProvisions, registryApps, vaultDelegationGrants, type AppProvisionRow, type NewAppProvisionRow } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { mintKeypair, emitMintedEvents, mintedKeyField } from '@/src/lib/vault/mint';
import { getMintedKeyByDid } from '@/src/lib/vault/key-cards';
import { grantExistingMintedKey, emitGrantEvents } from '@/src/lib/vault';
import {
  ensureRepoFromTemplate,
  tryGetInstallationToken,
  fetchAppManifest,
  appManifestError,
  DEFAULT_APP_TEMPLATE,
  PROVISIONING_ORG,
  type EnsureRepoResult,
  type AppManifest,
  type AppManifestResult,
} from '@/src/lib/github/org-provisioning';
import { seedAttestationTypes, type AttestationTypeSeedOutcome } from './attestation-types';
import { validateProfileWidget } from './profile-widget';
import { assertValidEntryUrl } from './entry-url';
import { configuredNodeUrl } from '@/src/lib/http/node-url';
import { validateAppDeclarations } from '@/src/lib/kernel/app-declarations';
import { validateEmittableEvents } from '@/src/lib/kernel/emittable-events';
import { NO_DECLARATIONS, sameDeclarations, type ManifestDeclarations } from './declarations-approval';
import { APP_SIGNING_KEY_PURPOSE, issueSigningKeyClaim } from './signing-key-claims';
import { validateSecrets } from './secret-declarations';
import { ensureAppDeclaredSecrets } from './self-secrets';
import type { VaultAuthorization } from '@/src/lib/vault/authorization';
import { provisionAppDomain, validateProvisionOwner } from './provision-domain';
import { APP_VISIBILITY_ERROR, isAppVisibility, type AppVisibility } from './visibility';

const log = createLogger('kernel:apps:provision');

/**
 * The literal host `apps.provision` used to register as every app's callback
 * (#2746). Never a real deployment — a provisioned row carrying it sends the
 * sign-in redirect to a host nobody owns.
 */
export const PLACEHOLDER_CALLBACK_HOST = 'your-node.imajin.ai';

/**
 * The node origin to register provisioned apps under (#2746), from the same
 * source the kernel uses for its other public URLs (`node-url.ts`). Throws —
 * so the caller fails closed BEFORE any repo is created or key minted — when
 * the node has no configured public URL, or it is the placeholder host.
 */
function resolveCallbackOrigin(): string {
  const origin = configuredNodeUrl();
  if (!origin) {
    throw new Error(
      'apps.provision: this node has no public URL configured (set APP_URL or NEXT_PUBLIC_BASE_URL) — refusing to register a callbackUrl',
    );
  }
  if (new URL(origin).hostname === PLACEHOLDER_CALLBACK_HOST) {
    throw new Error(`apps.provision: the configured node public URL is the placeholder host '${PLACEHOLDER_CALLBACK_HOST}'`);
  }
  return origin;
}

/** Purpose prefix recorded on the minted key's `vault_minted_keys` row. */
const APP_KEY_PURPOSE_PREFIX = 'apps.provision:';

export interface AppProvisionParams {
  authorizedBy?: VaultAuthorization;
  /** Directory visibility approved by the operator; omitted means public. */
  visibility?: AppVisibility;
  /** Ownership and host are part of the operator-countersigned proposal. */
  siteOwnerDid?: string;
  domain?: string;
  slug: string;
  displayName: string;
  template?: string;
  /** Optional `<slug>/<type>` attestation types to seed (2026-09-26 refinement). */
  attestationTypes?: string[];
  /**
   * The `providesScopes` / `dependsOn` list the operator approved on the /jin card
   * (#2663), snapshotted into the proposal at propose time. `registerApp` registers
   * the manifest's declarations only when they match this exactly; `null` /
   * omitted approves none.
   */
  approvedDeclarations?: ManifestDeclarations | null;
}

export interface AppProvisionSuccess {
  status: 'succeeded';
  repoUrl: string;
  appDid: string;
  /**
   * Actions secret NAMES only — never values. Always `[]` for a run made
   * after #2437 (nothing is sealed into Actions secrets any more); kept so
   * API consumers and `kernel.app_provisions` rows stay valid. A cached
   * pre-#2437 row replays whatever it recorded then.
   */
  secretsSet: string[];
  attestationTypeResults: AttestationTypeSeedOutcome[];
  /** Seeded legacy row retired by this provision, retained across retries (#2810). */
  retiredLegacyAppId?: string;
  /**
   * Plaintext one-time claim code (#2411) the app exchanges at first boot
   * for its own `app-signing-key` vault delegation grant, via
   * `POST /api/apps/claim`. Present on EVERY successful outcome (fresh or
   * idempotent-retry) — each execution issues a fresh code and expires any
   * prior still-pending one. Never persisted anywhere by this module or
   * its callers beyond this single return value; the operator-approvals
   * execution bridge surfaces it exactly once, in the decision response's
   * one-time `data` reveal (same posture as #2252's bearer plaintext).
   */
  claimCode: string;
}

export interface AppProvisionFailure {
  status: 'failed';
  failedStep: string;
  error: string;
  errorCode?: 'audience_conflict';
}

export type AppProvisionOutcome = AppProvisionSuccess | AppProvisionFailure;
/** A different identity still answers the requested audience: never hijack it. */
export class AppProvisionAudienceConflictError extends Error {
  readonly code = 'audience_conflict';

  constructor(slug: string, appId: string) {
    super(`apps.provision: audience '${slug}' is already answered by active row '${appId}' — refusing an audience shadow`);
    this.name = 'AppProvisionAudienceConflictError';
  }
}

/** Omit absent retirement metadata for compatibility with pre-cutover outcomes. */
function retirementContext(id: string | null | undefined): { retiredLegacyAppId?: string } {
  return id ? { retiredLegacyAppId: id } : {};
}

async function getProvisionRow(slug: string): Promise<AppProvisionRow | undefined> {
  const [row] = await db.select().from(appProvisions).where(eq(appProvisions.slug, slug)).limit(1);
  return row;
}

async function upsertProvisionRow(slug: string, patch: Partial<NewAppProvisionRow>): Promise<void> {
  const existing = await getProvisionRow(slug);
  if (existing) {
    await db.update(appProvisions).set({ ...patch, updatedAt: new Date() }).where(eq(appProvisions.slug, slug));
    return;
  }
  await db.insert(appProvisions).values({ slug, status: 'pending', ...patch });
}

function emitProvisionFailedEvent(nodeDid: string, slug: string, failedStep: string, error: string): void {
  publish('apps.provision.failed', {
    issuer: nodeDid,
    subject: nodeDid,
    scope: 'apps',
    payload: { slug, failedStep, error, context_id: slug, context_type: 'apps.provision' },
  }).catch((err: unknown) => log.error({ err: String(err), slug }, 'Bus publish error for apps.provision.failed'));
}

async function markFailed(nodeDid: string, slug: string, step: string, error: unknown): Promise<AppProvisionFailure> {
  const message = error instanceof Error ? error.message : String(error);
  await upsertProvisionRow(slug, { status: 'failed', failedStep: step, errorMessage: message });
  log.error({ slug, step, error: message }, 'apps.provision: step failed — no half-registered app is served');
  emitProvisionFailedEvent(nodeDid, slug, step, message);
  return {
    status: 'failed', failedStep: step, error: message,
    ...(error instanceof AppProvisionAudienceConflictError ? { errorCode: error.code } : {}),
  };
}

/**
 * Step 2 (mint): reuse an already-minted, active keypair for the ledger's
 * own `existingAppDid` when one is already known (idempotent retry —
 * `appDid` is persisted into `kernel.app_provisions` the moment minting
 * first succeeds), otherwise mint a FRESH keypair. Provisioned apps are
 * `tier: 'third_party'` (see `registerApp`'s docblock), so — unlike the
 * legacy `did:imajin:app-<slug>` first-party convention — the DID is
 * derived from the freshly minted public key (`mintKeypair`, the same
 * convention third-party self-service registration already uses), which
 * is what keeps it structurally distinct from any pre-existing legacy
 * first-party row's `app_did` (registry.apps.app_did is globally unique).
 *
 * Only the DID and PUBLIC key are returned (#2437): the plaintext private
 * key stays sealed in the vault and is never unsealed by this module — the
 * app gets it only through its own claim-code grant (`ensureAppSigningKeyGrant`).
 */
async function ensureMintedKeypair(
  slug: string,
  nodeDid: string,
  existingAppDid: string | null | undefined,
): Promise<{ did: string; publicKey: string }> {
  if (existingAppDid) {
    const existing = await getMintedKeyByDid(existingAppDid);
    if (existing?.status === 'active') {
      return { did: existingAppDid, publicKey: existing.publicKey };
    }
  }

  const purpose = `${APP_KEY_PURPOSE_PREFIX}${slug}`;
  const minted = await mintKeypair({
    purpose,
    requesterDid: nodeDid,
    mintedBy: nodeDid,
    // Not one-time: the node's self-granted (node -> node) copy stays
    // active alongside the app's own claim-code grant (see below).
    oneTime: false,
  });
  emitMintedEvents({ minted, purpose, requesterDid: nodeDid, mintedBy: nodeDid });

  return { did: minted.did, publicKey: minted.publicKey };
}

/**
 * Step 4 (grant, #2411): issue the app's OWN DID a delegation grant for
 * its just-minted key's field, on top of the pre-existing self-granted
 * (node -> node) copy `ensureMintedKeypair` mints. This is the SAME primitive
 * #2247's vault key cards use to add a second consumer to an already-minted key without
 * re-sealing (`grantExistingMintedKey`) — here the second consumer is the
 * app's own identity, purpose `app-signing-key`, `oneTime: false` (the app
 * may re-fetch across restarts for as long as its claim code, or a
 * reissued one, remains valid — see `signing-key-claims.ts`).
 *
 * Idempotent: reuses an already-active grant for (appDid, appDid, field,
 * purpose) rather than issuing a duplicate one on every retry —
 * `grantExistingMintedKey` itself has no such dedup (it exists to add
 * ADDITIONAL consumers), so this lookup is what keeps a re-run of an
 * already-succeeded provision from piling up redundant active grants for
 * the same tuple (which would also collide with the delegation grants
 * table's own one-active-row-per-tuple uniqueness).
 */
async function ensureAppSigningKeyGrant(appDid: string, nodeDid: string): Promise<string> {
  const field = mintedKeyField(appDid);

  const [existing] = await db
    .select({ id: vaultDelegationGrants.id })
    .from(vaultDelegationGrants)
    .where(
      and(
        eq(vaultDelegationGrants.subject, appDid),
        eq(vaultDelegationGrants.grantedTo, appDid),
        eq(vaultDelegationGrants.field, field),
        eq(vaultDelegationGrants.purpose, APP_SIGNING_KEY_PURPOSE),
        eq(vaultDelegationGrants.status, 'active'),
      ),
    )
    .limit(1);
  if (existing) {
    return existing.id;
  }

  const result = await grantExistingMintedKey({
    did: appDid,
    grantedTo: appDid,
    purpose: APP_SIGNING_KEY_PURPOSE,
    oneTime: false,
    grantedBy: nodeDid,
  });
  if (result.status !== 'ok') {
    throw new Error(`apps.provision: could not grant '${appDid}' its own app-signing-key (${result.status})`);
  }

  emitGrantEvents({ grantId: result.grantId, did: appDid, field, grantedTo: appDid, grantedBy: nodeDid });
  return result.grantId;
}

/**
 * Nav metadata (#2425) for a newly registered row: prefers the app's own
 * `imajin.app.json` manifest (see `fetchAppManifest`), falling back to a
 * sane default when optional nav fields are absent — an `entryUrl` derived
 * from the slug and a single `auth-submenu` placement, so a freshly
 * extracted app is at least reachable through the hub's dynamic
 * `/auth/[app]` route without requiring every template to have adopted the
 * optional nav fields yet. Unreadable/invalid manifests fail registration.
 *
 * A manifest `entryUrl` is untrusted third-party input (#2434): it must be a
 * root-relative path or an `https:` URL (see `entry-url.ts`). An invalid one
 * THROWS — the caller's `register` step turns that into a fail-closed
 * `failedStep: 'register'` outcome with a names-only invalid class, so no
 * registry row is written.
 */
function resolveNavMetadata(slug: string, manifest: AppManifest): {
  name: string | undefined;
  icon: string | null;
  entryUrl: string;
  placements: string[];
  requiredScope: string | null;
  profileWidget: AppManifest['profileWidget'];
} {
  const widget = validateProfileWidget(manifest.profileWidget);
  if ('error' in widget) throw new Error(widget.error);
  return {
    profileWidget: widget.ok,
    name: manifest.name,
    icon: manifest.icon ?? null,
    entryUrl: manifest.entryUrl === undefined ? `/${slug}` : assertValidEntryUrl(manifest.entryUrl),
    placements: manifest.placements ?? ['auth-submenu'],
    requiredScope: manifest.requiredScope ?? null,
  };
}

type ProvisionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
interface RegistrationRedirects {
  callbackUrl: string;
  allowedRedirectHosts: string[];
}

function resolveRegistrationRedirects(slug: string, domain?: string): RegistrationRedirects {
  const nodeOrigin = resolveCallbackOrigin();
  if (!domain) return { callbackUrl: `${nodeOrigin}/${slug}`, allowedRedirectHosts: [slug] };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.imajin\.ai$/.test(domain)) {
    throw new Error('Provisioned hosts must be direct imajin.ai subdomains; custom domains require TXT verification');
  }
  return { callbackUrl: `https://${domain}/api/auth/callback`, allowedRedirectHosts: [domain] };
}

/**
 * Lock both ownership seams before changing either: a manually cleared slug
 * does not remove an active audience. Only this slug's exact seed may retire.
 */
async function retireLegacyApp(tx: ProvisionTransaction, slug: string): Promise<string | null> {
  const legacyId = `app_first_party_${slug}`;
  const [holder] = await tx.select().from(registryApps)
    .where(eq(registryApps.slug, slug)).limit(1).for('update');
  if (holder && (holder.tier !== 'first_party' || holder.id !== legacyId)) {
    throw new Error(`apps.provision: slug '${slug}' is already held by '${holder.id}' — only seeded first-party legacy rows can be superseded (expected '${legacyId}')`);
  }
  const audienceHolders = await tx.select().from(registryApps).where(and(
    eq(registryApps.status, 'active'),
    arrayContains(registryApps.tokenAudiences, [slug]),
  )).for('update');
  for (const row of audienceHolders) {
    if (row.tier !== 'first_party' || row.id !== legacyId) {
      throw new AppProvisionAudienceConflictError(slug, row.id);
    }
  }
  const legacy = holder ?? audienceHolders[0];
  if (!legacy) return null;
  await tx.update(registryApps).set({
    status: 'revoked',
    revokedAt: sql`COALESCE(${registryApps.revokedAt}, NOW())`,
    updatedAt: sql`NOW()`,
    tokenAudiences: [],
    slug: null,
    placements: [],
  }).where(eq(registryApps.id, legacy.id));
  return legacy.id;
}

/**
 * Step 3 (register): insert a NEW `tier: 'third_party'` registry.apps row —
 * never upserting an existing identity. A slug holder may be superseded ONLY
 * when it is the exact seeded `first_party` row (`app_first_party_${slug}`).
 * Retirement uses 0185/0188's field set and commits with the new insert, so
 * there is no audience overlap or half-cutover. No app schema/data is touched.
 * This runs only through the countersigned apps:provision execution bridge.
 * Idempotent on `appDid` (always sourced from the
 * `kernel.app_provisions` ledger, so a retry passes the SAME appDid and
 * this lookup finds the row this same pipeline already created — never
 * the differently-app-did'd legacy row): a matching row already existing
 * is treated as "already registered", a no-op. Rows already retired by the
 * guarded migrations have no slug/audiences and are left untouched.
 */
async function registerApp(params: {
  slug: string;
  displayName: string;
  appDid: string;
  publicKey: string;
  manifest: AppManifest;
  approvedDeclarations: ManifestDeclarations | null;
  redirects: RegistrationRedirects;
  visibility: AppVisibility;
  retiredLegacyAppId: string | null;
  template: string;
  repoCreated: boolean;
  ownerDid: string;
}): Promise<{ id: string; allowedRedirectHosts: string[]; retiredLegacyAppId?: string }> {
  const { slug, displayName, appDid, publicKey, manifest, approvedDeclarations } = params;

  const [existing] = await db
    .select({
      id: registryApps.id,
      visibility: registryApps.visibility,
      callbackUrl: registryApps.callbackUrl,
      allowedRedirectHosts: registryApps.allowedRedirectHosts,
    })
    .from(registryApps)
    .where(eq(registryApps.appDid, appDid))
    .limit(1);

  if (existing) {
    if (existing.visibility !== params.visibility
      || existing.callbackUrl !== params.redirects.callbackUrl
      || JSON.stringify(existing.allowedRedirectHosts) !== JSON.stringify(params.redirects.allowedRedirectHosts)) {
      throw new Error('apps.provision: retry cannot change the registered visibility or callback — re-propose with the existing settings');
    }
    return { id: existing.id, allowedRedirectHosts: existing.allowedRedirectHosts, ...retirementContext(params.retiredLegacyAppId) };
  }

  let navMetadata: ReturnType<typeof resolveNavMetadata>;
  try {
    navMetadata = resolveNavMetadata(slug, manifest);
  } catch {
    throw new Error(appManifestError(slug, { error: 'invalid' }));
  }
  const secrets = validateSecrets(manifest.secrets);
  if ('error' in secrets) throw new Error(appManifestError(slug, { error: 'invalid' }));

  // #2663: scopes the app defines for itself + the audiences its tokens must
  // also carry, both read from the manifest. Fail-closed like `entryUrl`: a
  // bad declaration throws here, so no half-declared row is written.
  const declarations = await validateAppDeclarations({
    providesScopes: manifest.providesScopes,
    dependsOn: manifest.dependsOn,
    slug,
  });
  if ('error' in declarations) {
    throw new Error(appManifestError(slug, { error: 'invalid' }));
  }
  // #2638/#2641: the event types the app asks to emit via POST /api/events.
  const emittable = validateEmittableEvents(manifest.emittableEvents);
  if ('error' in emittable) {
    throw new Error(appManifestError(slug, { error: 'invalid' }));
  }
  // The operator approved a specific list on the /jin card; nothing beyond it is
  // granted. A manifest that changed since (or declares anything when none was
  // readable at proposal time) fails closed — re-propose to review the current list.
  const declared: ManifestDeclarations = {
    profileWidget: navMetadata.profileWidget,
    secrets: secrets.ok,
    providesScopes: declarations.ok.providesScopes,
    dependsOn: declarations.ok.dependsOn,
    emittableEvents: emittable.ok,
  };
  if (!sameDeclarations(declared, approvedDeclarations ?? NO_DECLARATIONS)) {
    throw new Error(
      'apps.provision: imajin.app.json declarations differ from the list the operator approved — re-propose to review the current providesScopes/dependsOn/emittableEvents',
    );
  }

  const id = `app_${nanoid(16)}`;
  return db.transaction(async (tx) => {
    const retiredLegacyAppId = await retireLegacyApp(tx, slug);
    await tx.insert(registryApps).values({
      id,
      ownerDid: params.ownerDid,
      name: navMetadata.name ?? displayName,
      description: `${displayName} (provisioned via apps.provision #2375)`,
      appDid,
      publicKey,
      // Explicit operator-approved hosts use the app's own auth callback.
      // Without one, preserve the node-path callback (#2746).
      ...params.redirects,
      visibility: params.visibility,
      tier: 'third_party',
      status: 'active',
      slug,
      sourceRepo: `${PROVISIONING_ORG}/${slug}`,
      template: params.template,
      // A newly generated repo starts joined; reusing a repo does not prove adoption.
      joined: params.repoCreated,
      tokenAudiences: [slug],
      icon: navMetadata.icon,
      entryUrl: navMetadata.entryUrl,
      profileWidget: navMetadata.profileWidget,
      placements: navMetadata.placements,
      requiredScope: navMetadata.requiredScope,
      // #2674: the whole approved list — the app's own scopes plus the scopes of the
      // dependencies the operator approved — is the ceiling PATCH and mint hold it to.
      requestedScopes: [...new Set([...declarations.ok.providesScopes, ...declarations.ok.dependsOn.flatMap((dep) => dep.scopes)])],
      secrets: secrets.ok,
      providesScopes: declarations.ok.providesScopes,
      dependsOn: declarations.ok.dependsOn,
      emittableEvents: emittable.ok,
    });
    // Commit the retirement's provenance with the cutover, not in a later step:
    // grant/claim/ledger failures must not erase it from the eventual retry result.
    await tx.update(appProvisions).set({
      registeredAt: new Date(),
      retiredLegacyAppId: retiredLegacyAppId ?? params.retiredLegacyAppId,
      updatedAt: new Date(),
    }).where(eq(appProvisions.slug, slug));
    return { id, allowedRedirectHosts: params.redirects.allowedRedirectHosts, ...retirementContext(retiredLegacyAppId ?? params.retiredLegacyAppId) };
  });
}

function emitRegisteredAttestation(nodeDid: string, appDid: string, registryAppId: string, displayName: string, slug: string, allowedRedirectHosts: string[], retirement: { retiredLegacyAppId?: string }): void {
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: appDid,
    type: 'registry.app.registered',
    context_id: registryAppId,
    context_type: 'registry_app',
    payload: { appId: registryAppId, name: displayName, tier: 'third_party', slug, tokenAudiences: [slug], allowedRedirectHosts, ...retirement },
  }).catch((err: unknown) => log.error({ err: String(err), registryAppId }, 'registry.app.registered attestation failed'));
}

function emitProvisionedEvent(nodeDid: string, slug: string, appDid: string, repoUrl: string, secretsSet: readonly string[], retirement: { retiredLegacyAppId?: string }): void {
  publish('apps.provisioned', {
    issuer: nodeDid,
    subject: appDid,
    scope: 'apps',
    payload: { slug, appDid, repoUrl, secretsSet: [...secretsSet], context_id: slug, context_type: 'apps.provision', ...retirement },
  }).catch((err: unknown) => log.error({ err: String(err), slug }, 'Bus publish error for apps.provisioned'));
}

/** Merge and de-duplicate newly-seeded attestation types into the row's recorded list. */
function mergeAttestationTypes(existing: readonly string[], newlySeeded: AttestationTypeSeedOutcome[]): string[] {
  const merged = new Set(existing);
  for (const outcome of newlySeeded) {
    if (outcome.ok) merged.add(outcome.type);
  }
  return [...merged];
}

/** Resume an already registered app without recreating its repo or identity. */
async function resumeSucceededProvision(
  params: AppProvisionParams, existingRun: AppProvisionRow, nodeDid: string,
): Promise<AppProvisionOutcome> {
    const { slug, attestationTypes = [] } = params;
    const succeededAppDid = existingRun.appDid ?? '';
    // Only an explicitly approved host retries issuance. Ordinary claim-code
    // recovery must not infer another host from the slug.
    if (params.domain) {
      try {
        await provisionAppDomain(succeededAppDid, slug, params.domain, params.siteOwnerDid);
      } catch (error) {
        return { status: 'failed', failedStep: 'domain', error: error instanceof Error ? error.message : 'Domain retry failed' };
      }
    }
    await ensureAppDeclaredSecrets(succeededAppDid, params.authorizedBy);
    const attestationTypeResults = attestationTypes.length > 0
      ? await seedAttestationTypes(succeededAppDid, slug, attestationTypes)
      : [];
    if (attestationTypeResults.length > 0) {
      await upsertProvisionRow(slug, {
        attestationTypes: mergeAttestationTypes(existingRun.attestationTypes, attestationTypeResults),
      });
    }
    // #2411: a re-approved provision for an already-succeeded slug is also
    // the operator's lever to reissue a fresh claim code (e.g. a prior one
    // expired unused, or the app's first-boot host never got it) — see
    // `POST /api/apps/provision`'s `reissueClaim` flag. The grant itself is
    // idempotent (`ensureAppSigningKeyGrant` reuses the existing active
    // row); only the claim code is genuinely fresh every time.
    const grantId = await ensureAppSigningKeyGrant(succeededAppDid, nodeDid);
    const claimCode = await issueSigningKeyClaim({ nodeDid, slug, appDid: succeededAppDid, grantId });
    return {
      status: 'succeeded',
      repoUrl: existingRun.repoUrl ?? '',
      appDid: succeededAppDid,
      secretsSet: existingRun.secretsSet,
      attestationTypeResults,
      claimCode,
      ...retirementContext(existingRun.retiredLegacyAppId),
    };
}

/**
 * Run (or resume) the full provisioning pipeline for one slug.
 * The operator bridge reports failed steps without exposing credentials.
 */
export async function runAppProvision(params: AppProvisionParams): Promise<AppProvisionOutcome> {
  const { slug, displayName, template = DEFAULT_APP_TEMPLATE, attestationTypes = [] } = params;
  const nodeDid = getNodeSigningIdentity().senderDid;
  const existingRun = await getProvisionRow(slug);
  if (existingRun?.status === 'succeeded') return resumeSucceededProvision(params, existingRun, nodeDid);

  // #2746: resolve the callback origin up front so a node with no public URL
  // fails closed before the repo is created or any key is minted.
  let redirects: RegistrationRedirects;
  const visibility = params.visibility ?? 'public';
  try {
    if (!isAppVisibility(visibility)) throw new Error(APP_VISIBILITY_ERROR);
    redirects = resolveRegistrationRedirects(slug, params.domain);
    await validateProvisionOwner(params.siteOwnerDid);
  } catch (err) {
    return markFailed(nodeDid, slug, 'config', err);
  }

  await upsertProvisionRow(slug, { status: 'pending' });

  // ── Step 1: repo ──────────────────────────────────────────────────────
  let repo: EnsureRepoResult;
  try {
    const ensured = await ensureRepoFromTemplate(slug, template);
    // A prior attempt may have created the repo before failing mint/register.
    // Finding it on retry must not erase durable template-creation provenance.
    repo = { ...ensured, created: ensured.created || existingRun?.repoCreated === true };
    await upsertProvisionRow(slug, { repoUrl: repo.repoUrl, repoCreated: repo.created });
  } catch (err) {
    return markFailed(nodeDid, slug, 'repo', err);
  }

  // ── Step 2: mint (kernel-internal — nothing external can observe this yet) ──
  // `appDid` is not known ahead of a fresh mint (it's derived from the
  // freshly generated public key — see `ensureMintedKeypair`'s docblock),
  // so it is persisted to the ledger the moment minting succeeds, letting a
  // later retry (if register fails) resolve the SAME minted key
  // instead of minting a second one for this slug.
  let keypair: { did: string; publicKey: string };
  try {
    keypair = await ensureMintedKeypair(slug, nodeDid, existingRun?.appDid);
    await upsertProvisionRow(slug, { appDid: keypair.did });
  } catch (err) {
    return markFailed(nodeDid, slug, 'mint', err);
  }
  const appDid = keypair.did;

  // ── Step 3: register (the app becomes servable ONLY from this point on) ──
  // #2813: unreadable/invalid manifests fail before registry writes or secret
  // issuance. Only a readable manifest may declare genuinely absent secrets.
  let registration: { id: string; allowedRedirectHosts: string[]; retiredLegacyAppId?: string };
  let retirement: { retiredLegacyAppId?: string };
  try {
    const manifestToken = await tryGetInstallationToken();
    const manifest: AppManifestResult = await fetchAppManifest(slug, manifestToken);
    if ('error' in manifest) {
      throw new Error(appManifestError(slug, manifest));
    }
    registration = await registerApp({
      slug,
      displayName,
      appDid,
      publicKey: keypair.publicKey,
      manifest: manifest.ok,
      approvedDeclarations: params.approvedDeclarations ?? null,
      redirects,
      visibility,
      retiredLegacyAppId: existingRun?.retiredLegacyAppId ?? null,
      template,
      repoCreated: repo.created,
      ownerDid: params.siteOwnerDid ?? params.authorizedBy?.operatorDid ?? 'did:imajin:platform',
    });
    retirement = retirementContext(registration.retiredLegacyAppId);
    emitRegisteredAttestation(nodeDid, appDid, registration.id, displayName, slug, registration.allowedRedirectHosts, retirement);
  } catch (err) {
    return markFailed(nodeDid, slug, 'register', err);
  }
  // Missing org signing prerequisites leave the host unbound, not the app
  // unable to boot. Conflicting or invalid bindings still fail closed.
  try {
    await provisionAppDomain(appDid, slug, params.domain, params.siteOwnerDid);
  } catch (err) {
    return markFailed(nodeDid, slug, 'domain', err);
  }

  // ── Step 4: app-signing-key grant + claim code (#2411, kernel-internal) ──
  // The app's own DID has no pre-existing identity to authenticate a
  // normal vault fetch with, so the vault grant is the app's ONLY route to
  // its key (#2437: it is never pushed to GitHub Actions secrets or an env
  // file): an active delegation grant to appDid itself, plus a one-time
  // claim code the app exchanges for it at first boot (see
  // `signing-key-claims.ts`). Runs unconditionally — unlike attestation
  // types, this isn't optional for a third-party app to be bootable off
  // the vault path.
  let grantId: string;
  let claimCode: string;
  try {
    await ensureAppDeclaredSecrets(appDid, params.authorizedBy);
    grantId = await ensureAppSigningKeyGrant(appDid, nodeDid);
    claimCode = await issueSigningKeyClaim({ nodeDid, slug, appDid, grantId });
  } catch (err) {
    return markFailed(nodeDid, slug, 'app-signing-key-grant', err);
  }

  // ── Step 5: attestation types (optional, additive) ───────────────────
  let attestationTypeResults: AttestationTypeSeedOutcome[] = [];
  if (attestationTypes.length > 0) {
    try {
      attestationTypeResults = await seedAttestationTypes(appDid, slug, attestationTypes);
    } catch (err) {
      return markFailed(nodeDid, slug, 'attestation-types', err);
    }
  }

  await upsertProvisionRow(slug, {
    status: 'succeeded',
    failedStep: null,
    errorMessage: null,
    attestationTypes: mergeAttestationTypes([], attestationTypeResults),
  });

  // Nothing is sealed into Actions secrets any more (#2437): report whatever the
  // ledger row already recorded (a pre-#2437 row keeps its history), else [].
  const secretsSet = existingRun?.secretsSet ?? [];
  emitProvisionedEvent(nodeDid, slug, appDid, repo.repoUrl, secretsSet, retirement);

  return { status: 'succeeded', repoUrl: repo.repoUrl, appDid, secretsSet, attestationTypeResults, claimCode, ...retirement };
}

/** Current ledger status for a slug, for `GET /api/apps/provision?slug=`. Undefined when never provisioned. */
export async function getAppProvisionStatus(slug: string): Promise<AppProvisionRow | undefined> {
  return getProvisionRow(slug);
}
