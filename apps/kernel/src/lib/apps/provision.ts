/**
 * `apps.provision` (#2375) — gate 1+2 of epic #2370: one kernel-authoritative
 * call that creates an extracted app's GitHub repo, registers it in the
 * existing `registry.apps` table (#1990) as a `tier: 'third_party'` row
 * (never upserting any pre-existing legacy `first_party` row for the same
 * app — see `registerApp`'s docblock), and seals its app-auth private key +
 * a GitHub-Packages-read token into the repo's Actions secrets.
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
 * by that same appDid, never an upsert; seal: skip once `sealedAt` is set),
 * so a retry only re-attempts whatever didn't already succeed.
 *
 * ## No half-registered app is ever servable
 * The `registry.apps` row (the thing that makes an app "servable" —
 * `resolveActiveAppByAudience`/`isAppDidActive`) is written only AFTER a
 * real Ed25519 keypair already exists and is durably vault-sealed (steps
 * 1-2 succeed first) — never with a placeholder key. Only the external
 * GitHub Actions-secret push (network-fallible) can still fail after that
 * point, and a retry re-attempts only that step.
 *
 * ## Credential custody
 * The minted app private key is generated in-process, immediately sealed
 * into the vault (self-granted to the node — see `ensureMintedKeypair`),
 * and the ONLY other place its plaintext ever exists is the one in-memory
 * round trip to encrypt-and-PUT it as a GitHub Actions secret. It is never
 * logged, never part of any bus event/attestation payload, and never part
 * of this module's return value — see `AppProvisionSuccess.secretsSet`,
 * which carries secret NAMES only.
 */
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, appProvisions, registryApps, vaultDelegationGrants, type AppProvisionRow, type NewAppProvisionRow } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { mintKeypair, emitMintedEvents, mintedKeyField } from '@/src/lib/vault/mint';
import { getMintedKeyByDid } from '@/src/lib/vault/key-cards';
import { loadAndUnsealByGrantee, grantExistingMintedKey, emitGrantEvents } from '@/src/lib/vault';
import {
  ensureRepoFromTemplate,
  sealActionsSecret,
  tryLoadOrgCredential,
  PROVISIONING_ORG,
  DEFAULT_APP_TEMPLATE,
  type EnsureRepoResult,
} from '@/src/lib/github/org-provisioning';
import { seedAttestationTypes, type AttestationTypeSeedOutcome } from './attestation-types';
import { APP_SIGNING_KEY_PURPOSE, issueSigningKeyClaim } from './signing-key-claims';

const log = createLogger('kernel:apps:provision');

/** Purpose prefix recorded on the minted key's `vault_minted_keys` row. */
const APP_KEY_PURPOSE_PREFIX = 'apps.provision:';

/** Actions secret names apps.provision seals — names only, values are never logged/returned. */
export const IMAJIN_APP_PRIVATE_KEY_SECRET = 'IMAJIN_APP_PRIVATE_KEY';
export const GITHUB_PACKAGES_TOKEN_SECRET = 'GITHUB_PACKAGES_TOKEN';

export interface AppProvisionParams {
  slug: string;
  displayName: string;
  template?: string;
  /** Optional `<slug>/<type>` attestation types to seed (2026-09-26 refinement). */
  attestationTypes?: string[];
}

export interface AppProvisionSuccess {
  status: 'succeeded';
  repoUrl: string;
  appDid: string;
  /** Actions secret NAMES only — never values. */
  secretsSet: string[];
  attestationTypeResults: AttestationTypeSeedOutcome[];
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
  /**
   * True when the seal step (#2415) was skipped because the org-scoped
   * GitHub credential was never sealed — `secretsSet` is `[]` in that case.
   * Derived from `sealedAt IS NULL` on an otherwise-`succeeded` ledger row
   * (reusing that existing column rather than adding a new one), since
   * every succeeded row reached that status via a real seal before #2415.
   */
  sealSkipped: boolean;
}

export interface AppProvisionFailure {
  status: 'failed';
  failedStep: string;
  error: string;
}

export type AppProvisionOutcome = AppProvisionSuccess | AppProvisionFailure;

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
  return { status: 'failed', failedStep: step, error: message };
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
 * Either way, the plaintext private key is fetched back out via
 * `loadAndUnsealByGrantee` (self-granted node -> node, `oneTime: false`)
 * so the caller has it in hand for the one-shot GitHub Actions-secret seal
 * — never returned from this function's own return value in any other
 * form, and never logged.
 */
async function ensureMintedKeypair(
  slug: string,
  nodeDid: string,
  existingAppDid: string | null | undefined,
): Promise<{ did: string; publicKey: string; privateKey: string }> {
  if (existingAppDid) {
    const existing = await getMintedKeyByDid(existingAppDid);
    if (existing && existing.status === 'active') {
      const privateKey = await loadAndUnsealByGrantee(existing.field, nodeDid);
      if (privateKey === undefined) {
        throw new Error(`apps.provision: minted key for '${existingAppDid}' exists but its sealed private key could not be unsealed`);
      }
      return { did: existingAppDid, publicKey: existing.publicKey, privateKey };
    }
  }

  const purpose = `${APP_KEY_PURPOSE_PREFIX}${slug}`;
  const minted = await mintKeypair({
    purpose,
    requesterDid: nodeDid,
    mintedBy: nodeDid,
    // Not one-time: the kernel is both principal-adjacent and grantee here
    // (self-granted), and may need to re-fetch the plaintext across retries
    // of the external Actions-secret seal step (see this module's docblock).
    oneTime: false,
  });
  emitMintedEvents({ minted, purpose, requesterDid: nodeDid, mintedBy: nodeDid });

  const privateKey = await loadAndUnsealByGrantee(minted.field, nodeDid);
  if (privateKey === undefined) {
    throw new Error(`apps.provision: freshly minted key for '${minted.did}' could not be re-unsealed`);
  }
  return { did: minted.did, publicKey: minted.publicKey, privateKey };
}

/**
 * Step 4.5 (grant, #2411): issue the app's OWN DID a delegation grant for
 * its just-minted key's field, on top of the pre-existing self-granted
 * (node -> node) copy `ensureMintedKeypair` already holds for the
 * GitHub-Actions-secret seal. This is the SAME primitive #2247's vault key
 * cards use to add a second consumer to an already-minted key without
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
 * Step 3 (register): insert a NEW `tier: 'third_party'` registry.apps row —
 * NEVER updates/upserts an existing row, and in particular never touches a
 * pre-existing LEGACY `tier: 'first_party'` row for the same slug (e.g.
 * dykil's `app_first_party_dykil`, seeded by
 * `0139_registry_apps_seed_first_party.sql` before #1985/#1991's
 * extraction). Idempotent on `appDid` (always sourced from the
 * `kernel.app_provisions` ledger, so a retry passes the SAME appDid and
 * this lookup finds the row this same pipeline already created — never
 * the differently-app-did'd legacy row): a matching row already existing
 * is treated as "already registered", a no-op. Returns the row id.
 *
 * If a legacy row's `slug` was ever left set for this same slug (only
 * possible for an app `0163_registry_apps_slug.sql` did NOT deliberately
 * exclude), the INSERT below fails on `registry.apps`'s unique `slug`
 * index — correctly fail-closed at the 'register' step, since provisioning
 * an app whose slug is still claimed by an untouched legacy row would
 * otherwise silently produce two rows answering to the same slug.
 */
async function registerApp(params: {
  slug: string;
  displayName: string;
  appDid: string;
  publicKey: string;
}): Promise<string> {
  const { slug, displayName, appDid, publicKey } = params;

  const [existing] = await db
    .select({ id: registryApps.id })
    .from(registryApps)
    .where(eq(registryApps.appDid, appDid))
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const id = `app_${nanoid(16)}`;
  await db.insert(registryApps).values({
    id,
    ownerDid: 'did:imajin:platform',
    name: displayName,
    description: `${displayName} (provisioned via apps.provision #2375)`,
    appDid,
    publicKey,
    // Placeholder host — an operator can register the app's real deployed
    // host later via the admin surface once it's actually deployed (#2060).
    callbackUrl: `https://your-node.imajin.ai/${slug}`,
    tier: 'third_party',
    status: 'active',
    slug,
    allowedRedirectHosts: [slug],
    tokenAudiences: [slug],
  });
  return id;
}

function emitRegisteredAttestation(nodeDid: string, appDid: string, registryAppId: string, displayName: string, slug: string): void {
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: appDid,
    type: 'registry.app.registered',
    context_id: registryAppId,
    context_type: 'registry_app',
    payload: { appId: registryAppId, name: displayName, tier: 'third_party', slug, tokenAudiences: [slug], allowedRedirectHosts: [slug] },
  }).catch((err: unknown) => log.error({ err: String(err), registryAppId }, 'registry.app.registered attestation failed'));
}

interface SealDeploySecretsResult {
  secretsSet: string[];
  /** True when the org credential was never sealed — the step was skipped, not attempted and failed. */
  skipped: boolean;
}

function emitSealSkippedEvent(nodeDid: string, slug: string): void {
  publish('apps.provision.seal.skipped', {
    issuer: nodeDid,
    subject: nodeDid,
    scope: 'apps',
    payload: { slug, reason: 'org-credential-unsealed', context_id: slug, context_type: 'apps.provision' },
  }).catch((err: unknown) => log.error({ err: String(err), slug }, 'Bus publish error for apps.provision.seal.skipped'));
}

/**
 * Step 4 (seal): seal the app's private key + the reused org credential as
 * GitHub-Packages-read token. #2415: when the org credential was never
 * sealed, this DEGRADES rather than fails — there is no template-CI to seal
 * secrets into for a dev-path app (it fetches its signing key from the
 * vault at boot instead, #2411), so an unsealed credential must not block
 * the rest of the chain (grant + claim code).
 */
async function sealDeploySecrets(slug: string, privateKey: string): Promise<SealDeploySecretsResult> {
  const repo = `${PROVISIONING_ORG}/${slug}`;
  const orgCredential = await tryLoadOrgCredential();
  if (orgCredential === null) {
    return { secretsSet: [], skipped: true };
  }

  await sealActionsSecret(repo, IMAJIN_APP_PRIVATE_KEY_SECRET, privateKey);
  await sealActionsSecret(repo, GITHUB_PACKAGES_TOKEN_SECRET, orgCredential);

  return { secretsSet: [IMAJIN_APP_PRIVATE_KEY_SECRET, GITHUB_PACKAGES_TOKEN_SECRET], skipped: false };
}

/**
 * Step 4 runner: resumes from an already-sealed retry, otherwise attempts
 * sealing and persists whichever outcome results — sealed (`sealedAt` set)
 * or skipped (#2415: `secretsSet: []`, `sealedAt` left null, `seal.skipped`
 * bus event). Extracted out of `runAppProvision` purely to keep that
 * function's own cognitive complexity down.
 */
async function runSealStep(
  slug: string,
  nodeDid: string,
  privateKey: string,
  existingRun: Pick<AppProvisionRow, 'sealedAt' | 'secretsSet'> | undefined,
): Promise<SealDeploySecretsResult> {
  if (existingRun?.sealedAt) {
    return { secretsSet: existingRun.secretsSet, skipped: false };
  }

  const sealResult = await sealDeploySecrets(slug, privateKey);
  if (sealResult.skipped) {
    await upsertProvisionRow(slug, { secretsSet: sealResult.secretsSet });
    emitSealSkippedEvent(nodeDid, slug);
  } else {
    await upsertProvisionRow(slug, { sealedAt: new Date(), secretsSet: sealResult.secretsSet });
  }
  return sealResult;
}

function emitProvisionedEvent(nodeDid: string, slug: string, appDid: string, repoUrl: string, secretsSet: readonly string[]): void {
  publish('apps.provisioned', {
    issuer: nodeDid,
    subject: appDid,
    scope: 'apps',
    payload: { slug, appDid, repoUrl, secretsSet: [...secretsSet], context_id: slug, context_type: 'apps.provision' },
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

/**
 * Run (or resume) the full provisioning pipeline for one slug. Never
 * throws — every outcome is `{ status: 'succeeded' | 'failed', ... }`, so
 * the operator-approvals execution bridge can report it uniformly.
 */
export async function runAppProvision(params: AppProvisionParams): Promise<AppProvisionOutcome> {
  const { slug, displayName, template = DEFAULT_APP_TEMPLATE, attestationTypes = [] } = params;
  const nodeDid = getNodeSigningIdentity().senderDid;

  const existingRun = await getProvisionRow(slug);

  // Idempotent on slug: a prior success returns the cached result without
  // re-creating anything — but a newly requested attestationTypes list is
  // still additive-seeded, since that step never re-creates the app itself.
  // `existingRun.appDid` is always set by the time a run reaches 'succeeded'
  // (it's persisted right after the mint step below succeeds).
  if (existingRun?.status === 'succeeded') {
    const succeededAppDid = existingRun.appDid ?? '';
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
      sealSkipped: !existingRun.sealedAt,
    };
  }

  await upsertProvisionRow(slug, { status: 'pending' });

  // ── Step 1: repo ──────────────────────────────────────────────────────
  let repo: EnsureRepoResult;
  try {
    repo = await ensureRepoFromTemplate(slug, template);
    await upsertProvisionRow(slug, { repoUrl: repo.repoUrl, repoCreated: repo.created });
  } catch (err) {
    return markFailed(nodeDid, slug, 'repo', err);
  }

  // ── Step 2: mint (kernel-internal — nothing external can observe this yet) ──
  // `appDid` is not known ahead of a fresh mint (it's derived from the
  // freshly generated public key — see `ensureMintedKeypair`'s docblock),
  // so it is persisted to the ledger the moment minting succeeds, letting a
  // later retry (if register/seal fails) resolve the SAME minted key
  // instead of minting a second one for this slug.
  let keypair: { did: string; publicKey: string; privateKey: string };
  try {
    keypair = await ensureMintedKeypair(slug, nodeDid, existingRun?.appDid);
    await upsertProvisionRow(slug, { appDid: keypair.did });
  } catch (err) {
    return markFailed(nodeDid, slug, 'mint', err);
  }
  const appDid = keypair.did;

  // ── Step 3: register (the app becomes servable ONLY from this point on) ──
  let registryAppId: string;
  try {
    registryAppId = await registerApp({ slug, displayName, appDid, publicKey: keypair.publicKey });
    await upsertProvisionRow(slug, { registeredAt: new Date() });
    emitRegisteredAttestation(nodeDid, appDid, registryAppId, displayName, slug);
  } catch (err) {
    return markFailed(nodeDid, slug, 'register', err);
  }

  // ── Step 4: seal (external, network-fallible — the only step a retry ever repeats) ──
  // #2415: an unsealed org credential degrades this step (secretsSet: [],
  // sealedAt left null) rather than failing it — a retry with `sealedAt`
  // still null naturally re-attempts sealing, which is exactly right if the
  // operator has since sealed the credential.
  let secretsSet: string[];
  let sealSkipped: boolean;
  try {
    const sealResult = await runSealStep(slug, nodeDid, keypair.privateKey, existingRun);
    secretsSet = sealResult.secretsSet;
    sealSkipped = sealResult.skipped;
  } catch (err) {
    return markFailed(nodeDid, slug, 'seal', err);
  }

  // ── Step 5: app-signing-key grant + claim code (#2411, kernel-internal) ──
  // The app's own DID has no pre-existing identity to authenticate a
  // normal vault fetch with, so this is a SECOND destination for the same
  // freshly minted key: an active delegation grant to appDid itself, plus
  // a one-time claim code the app exchanges for it at first boot (see
  // `signing-key-claims.ts`). Runs unconditionally — unlike attestation
  // types, this isn't optional for a third-party app to be bootable off
  // the vault path.
  let grantId: string;
  let claimCode: string;
  try {
    grantId = await ensureAppSigningKeyGrant(appDid, nodeDid);
    claimCode = await issueSigningKeyClaim({ nodeDid, slug, appDid, grantId });
  } catch (err) {
    return markFailed(nodeDid, slug, 'app-signing-key-grant', err);
  }

  // ── Step 6: attestation types (optional, additive) ───────────────────
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

  emitProvisionedEvent(nodeDid, slug, appDid, repo.repoUrl, secretsSet);

  return { status: 'succeeded', repoUrl: repo.repoUrl, appDid, secretsSet, attestationTypeResults, claimCode, sealSkipped };
}

/** Current ledger status for a slug, for `GET /api/apps/provision?slug=`. Undefined when never provisioned. */
export async function getAppProvisionStatus(slug: string): Promise<AppProvisionRow | undefined> {
  return getProvisionRow(slug);
}
