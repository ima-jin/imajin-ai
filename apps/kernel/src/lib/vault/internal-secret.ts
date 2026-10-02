/**
 * Kernel-internal, self-provisioned secrets (#2245 — first target of the
 * #2241 vault-native-credentials epic, ahead of `ATTESTATION_INTERNAL_API_KEY`).
 *
 * Ruling (Ryan, 2026-09-22, via #2245): a shared, cross-service secret
 * needs a human to countersign import/rotate/revoke, but an internal
 * secret with a single in-process consumer (never fanned out to another
 * service) doesn't need a human to *exist* — only to be replaced or
 * destroyed. On first boot, the kernel looks up a static-secret grant for
 * the given `purpose` bound to its OWN node DID (self-granted: subject ===
 * grantedTo, exactly the Tier 0 custody model `sealAndGrantStaticSecret`
 * already implements for #1439/#2231); if none exists yet, it generates 32
 * random bytes in-process, seals + grants them to itself via that same
 * existing static-secret path, and emits exactly ONE mechanical
 * `vault.secret.generated` attestation binding the purpose/grantId/content
 * hash — never the bytes. Human countersign (canvas card, #2084 roles)
 * stays reserved for import / rotate / revoke, never for this
 * self-provisioning path.
 *
 * First consumer: `hmacForeignPrincipalRef`
 * (apps/kernel/src/lib/auth/foreign-principal-stub.ts), replacing the
 * hand-set `FOREIGN_PRINCIPAL_STUB_SECRET` env var entirely.
 *
 * ## Concurrency (two boots racing)
 * Both instances race to answer "does an active grant exist yet?". There
 * is a real window between that read and this process's own seal+grant
 * completing, so a DB-enforced claim
 * (`kernel.internal_secret_provisions`, UNIQUE on `(owner_did, purpose)`,
 * migration 0153) makes exactly one of them the winner, matching this
 * codebase's existing "insert with onConflictDoNothing, re-read on loss"
 * idiom (see `getOrCreateSystemFolder`, `insertActiveGrant`) rather than a
 * novel locking primitive:
 *   - the winner's claim insert succeeds -> it generates, seals, grants,
 *     attests, and uses its own freshly generated value directly (no
 *     re-fetch — sealAndGrantStaticSecret already returns nothing to
 *     re-fetch, and the plaintext is already in hand).
 *   - the loser's claim insert conflicts -> it generates nothing; it
 *     polls for the winner's now-active grant and fetches THAT value, so
 *     the two processes never end up with two different secrets for the
 *     same purpose.
 * A winner that FAILS (e.g. sealAndGrantStaticSecret throws) rolls its own
 * claim back immediately, so a retry — in this process or another — is
 * never blocked by that failure.
 *
 * ## No purpose-tagged grant → adopt before generating (#2446)
 * A claim row can outlive its grant, and a grant can lose its purpose: a
 * pre-#2446 operator rotation minted the replacement with `purpose = NULL`,
 * an operator may delete the row by hand (prod, 2026-09-29), a winner can
 * be SIGKILLed mid-seal. Polling for a winner that does not exist failed
 * every request forever. Now a row that recorded a grant yet has no active
 * purpose-tagged grant, or a grant-less claim older than STALE_CLAIM_MS, is
 * released and re-claimed through the same unique-constraint claim (one
 * winner). EVERY claim holder — first boot included — then reads the field
 * before generating: readable through the node's self-grant → re-tag that
 * grant with the purpose and repoint the row (bookkeeping only: no
 * re-seal, grantees untouched, one WARN); tamper-class failure → error,
 * claim kept; nothing readable → generate, with an ERROR naming any
 * grantee left on a dead key. A boot never re-keys a shared secret.
 *
 * ## The node's own grant never expires (#2451)
 * The self-grant is how the kernel reads its own secret, so a TTL on it can
 * only ever become a lockout (`not fetchable (status: expired)` on every
 * lookup, then an env fallback nobody sees). A pre-#2446 rotate stamped one
 * via `VAULT_GRANT_TTL_DAYS`, and re-tagging used to keep it. Now the re-tag
 * AND every boot that finds an expiring self-grant clear it — re-signing the
 * grant with the node key (`expiresAt` is part of the signed payload), no
 * re-seal, no new key. Where the node cannot re-sign (Tier 1, foreign signer,
 * erased key material) it WARNs with the expiry date instead.
 *
 * ## Rotation (#2446)
 * The lookup resolves the CURRENT grant for `(subject, grantedTo, purpose)`
 * by filtering on `status = 'active'`. Rotation (`rotateAndStore` →
 * `internal-secret-rotate.ts`) re-seals through
 * {@link sealAndRecordInternalSecret} — the same path generation uses — so
 * the new grant keeps its purpose and the provisions row follows it. The
 * process cache is dropped on rotate directly, and on any
 * `vault.secret.rotated`/`updated` event for the field via the vault
 * hot-reload subscription, so a rotated value is picked up without a
 * restart.
 *
 * ## Fetch + ack (#2231/#2235/#2257)
 * Reading an EXISTING grant goes through the exact same agent-facing
 * `fetchGrantSecret`/`ackGrant` pair every other purpose-bound grant
 * uses — one deferred `used` ack per fetch, never at fetch time. A
 * freshly GENERATED secret never calls either: there is nothing to fetch,
 * since the plaintext is already in hand from generation.
 */
import { randomBytes, createHash } from 'node:crypto';
import { VaultIntegrityError, type VaultEntry } from '@imajin/vault-core';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { and, eq, isNull } from 'drizzle-orm';
import { db, vaultDelegationGrants, internalSecretProvisions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeSigningIdentity } from './sealing';
import { VaultDelegationError } from './errors';
import {
  sealAndGrantStaticSecret,
  fetchGrantSecret,
  ackGrant,
  loadAndUnseal,
  clearSelfGrantExpiry,
  activeGrantTuple,
  type DbExecutor,
} from './index';
import { ensureVaultHotReloadReactorRegistered, subscribeToSecret } from './subscribe';

const log = createLogger('kernel');

/** Field-name prefix every self-provisioned internal secret lives under. */
export const INTERNAL_SECRET_FIELD_PREFIX = 'internal-secret:';

/** Vault field name holding a self-provisioned internal secret for `purpose`. */
export function internalSecretField(purpose: string): string {
  return `${INTERNAL_SECRET_FIELD_PREFIX}${purpose}`;
}

/** True when `field` is an `internal-secret:*` field (#2446 — rotation routes these specially). */
export function isInternalSecretField(field: string): boolean {
  return field.startsWith(INTERNAL_SECRET_FIELD_PREFIX) && field.length > INTERNAL_SECRET_FIELD_PREFIX.length;
}

/** Inverse of {@link internalSecretField}: the purpose an `internal-secret:*` field is for. */
export function purposeFromInternalSecretField(field: string): string {
  if (!isInternalSecretField(field)) {
    throw new Error(`purposeFromInternalSecretField: '${field}' is not an internal-secret field`);
  }
  return field.slice(INTERNAL_SECRET_FIELD_PREFIX.length);
}

// Process-lifetime cache: getInternalSecret only ever fetches-or-generates
// once per purpose per process. Caching the in-flight PROMISE (not just the
// resolved value) means concurrent in-process callers for the same purpose
// share one resolution instead of racing each other into the DB.
const secretCache = new Map<string, Promise<string>>();

// Purposes this process already watches for rotation (#2446 fix 3) — one
// vault subscription per purpose per process, never one per call.
const watchedPurposes = new Set<string>();

// A claim row with no grant recorded yet belongs to a winner that is still
// sealing — or one that crashed between claiming and rolling back. Sealing
// is local DB + in-process crypto (see POLL_* below), so a claim this old
// can only be the crashed case and is safe to re-claim (#2446).
const STALE_CLAIM_MS = 60_000;

// Local DB + in-process crypto only, no network hop — a few hundred ms is
// far beyond what a healthy winner needs to seal+grant, and bounding the
// loop keeps a genuinely crashed winner from hanging a loser forever.
const POLL_INTERVAL_MS = 10;
const POLL_ATTEMPTS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ActiveInternalSecretGrant {
  grantId: string;
  /** Set only on a grant that will stop being fetchable — see {@link ensureSelfGrantNeverExpires}. */
  expiresAt: Date | null;
}

/**
 * The CURRENT (`status = 'active'`) self-granted row for
 * `(ownerDid, purpose)`, or undefined when none exists yet — see this
 * module's "Rotation seam" docblock section for why this simple filter is
 * already rotation-safe.
 */
async function findActiveGrant(ownerDid: string, purpose: string): Promise<ActiveInternalSecretGrant | undefined> {
  const [row] = await db
    .select({ grantId: vaultDelegationGrants.id, expiresAt: vaultDelegationGrants.expiresAt })
    .from(vaultDelegationGrants)
    .where(
      and(
        eq(vaultDelegationGrants.subject, ownerDid),
        eq(vaultDelegationGrants.grantedTo, ownerDid),
        eq(vaultDelegationGrants.purpose, purpose),
        eq(vaultDelegationGrants.status, 'active'),
      ),
    )
    .limit(1);
  return row ? { grantId: row.grantId, expiresAt: row.expiresAt instanceof Date ? row.expiresAt : null } : undefined;
}

/**
 * Make the node's own grant non-expiring (#2451) so it can never silently
 * lock the kernel out of its own secret. Best effort by design: a failure
 * here must not turn a boot that could still read the secret into one that
 * cannot, so it is logged and the caller carries on. Where the node cannot
 * re-sign the grant itself, WARN with the date so an operator can rotate.
 */
async function ensureSelfGrantNeverExpires(purpose: string, grantId: string): Promise<void> {
  try {
    const result = await clearSelfGrantExpiry(grantId);
    if (result.status === 'cleared') {
      log.warn(
        { purpose, grantId, previousExpiresAt: result.previousExpiresAt.toISOString() },
        "getInternalSecret: the node's own grant carried an expiry — cleared it so the kernel can never lock itself out (#2451)",
      );
    } else if (result.status === 'blocked') {
      log.warn(
        { purpose, grantId, expiresAt: result.expiresAt.toISOString(), reason: result.reason },
        "getInternalSecret: the node's own grant expires and the node cannot re-sign it itself — rotate it from /admin/vault before that date or the kernel falls back to env (#2451)",
      );
    }
  } catch (err) {
    log.error({ err: String(err), purpose, grantId }, 'getInternalSecret: could not clear the self-grant expiry (non-fatal) (#2451)');
  }
}

/** Fetch an existing self-granted secret and send its one deferred `used` ack. */
async function fetchAndAck(ownerDid: string, grantId: string, purpose: string): Promise<string> {
  const outcome = await fetchGrantSecret({ grantId, granteeDid: ownerDid });
  if (outcome.status !== 'ok') {
    throw new Error(
      `getInternalSecret: grant '${grantId}' for purpose '${purpose}' exists but is not fetchable (status: ${outcome.status})`,
    );
  }

  // Non-fatal: the ack is bookkeeping layered on top of an already-successful
  // fetch — never block the caller's use of a secret it has already obtained.
  await ackGrant({ grantId, granteeDid: ownerDid, outcome: 'used' }).catch((err: unknown) => {
    log.error({ err: String(err), grantId, purpose }, 'getInternalSecret: ack failed (non-fatal)');
  });

  return outcome.value;
}

/**
 * Produces the plaintext for a brand-new internal secret. Defaults to 32
 * random bytes (opaque tokens/peppers); a caller with a structured secret
 * — e.g. an asymmetric keypair — supplies its own via
 * {@link getOrGenerateInternalSecret} instead (#2291's VAPID keys).
 */
export type SecretGenerator = () => string;

/** The default plaintext generator: 32 random bytes, hex-encoded — an opaque token/pepper. */
const DEFAULT_SECRET_GENERATOR: SecretGenerator = () => randomBytes(32).toString('hex');

/**
 * Seal `value` as the purpose-tagged, self-granted internal secret for
 * `(ownerDid, purpose)` and point the provisions row at the new grant. The
 * one custody path for these fields: first-boot generation, bootstrap
 * re-provisioning, and operator rotation (#2446) all go through here, so
 * the grant's `purpose` and the provisions row can never disagree.
 *
 * Supersedes the prior self-grant for the field (whatever its purpose) via
 * `sealAndGrantStaticSecret`'s own rotation semantics.
 *
 * With `tx` (operator rotation, #2451) the grant and the provisions row are
 * written on that transaction and the vault entry is NOT persisted: the
 * caller saves it with `vaultService.set(entry)` as the last step inside the
 * same transaction, so a failure anywhere rolls everything back.
 */
export async function sealAndRecordInternalSecret(
  ownerDid: string,
  purpose: string,
  value: string,
  tx?: DbExecutor,
): Promise<{ entry: VaultEntry; grantId: string }> {
  const field = internalSecretField(purpose);
  const { entry, grantId } = await sealAndGrantStaticSecret(field, value, {
    principalDid: ownerDid,
    granteeDid: ownerDid,
    purpose,
    oneTime: false,
    tx,
  });

  if (!grantId) {
    // Tier 1 (external owner agent) cannot self-grant — #2245 is Tier 0
    // only for now; a Tier 1 kernel needs an operator-side bridge this
    // slice doesn't build. Fail loudly rather than handing back a value
    // nothing has actually granted this node access to.
    throw new Error(
      `getInternalSecret: sealAndGrantStaticSecret returned no grantId for purpose '${purpose}' — ` +
        'Tier 1 vault custody is not supported for self-provisioned internal secrets yet',
    );
  }

  await recordProvisionGrant(ownerDid, purpose, grantId, tx);
  return { entry, grantId };
}

/**
 * Point the `(ownerDid, purpose)` provisions row at `grantId`, creating the
 * row when none exists (a field imported/rotated before it was ever
 * self-provisioned). Upsert on the same unique key the claim uses.
 */
async function recordProvisionGrant(
  ownerDid: string,
  purpose: string,
  grantId: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .insert(internalSecretProvisions)
    .values({ id: generateId('isp'), ownerDid, purpose, field: internalSecretField(purpose), grantId })
    .onConflictDoUpdate({
      target: [internalSecretProvisions.ownerDid, internalSecretProvisions.purpose],
      set: { grantId },
    });
}

/** Generate, seal, self-grant, and attest a brand-new internal secret. Only the claim winner calls this. */
async function generateAndSeal(ownerDid: string, purpose: string, generate: SecretGenerator): Promise<string> {
  const value = generate();
  const { grantId } = await sealAndRecordInternalSecret(ownerDid, purpose, value);

  const contentHash = createHash('sha256').update(value).digest('hex');

  emitAttestation({
    issuer_did: ownerDid,
    subject_did: ownerDid,
    type: 'vault.secret.generated',
    context_id: grantId,
    context_type: 'vault.internal-secret',
    payload: { purpose, grantId, contentHash },
  }).catch((err: unknown) =>
    log.error({ err: String(err), purpose, grantId }, 'vault.secret.generated attestation failed'),
  );

  publish('vault.secret.generated', {
    issuer: ownerDid,
    subject: ownerDid,
    scope: 'vault',
    payload: {
      purpose,
      grantId,
      contentHash,
      context_id: grantId,
      context_type: 'vault.internal-secret',
    },
  }).catch((err: unknown) =>
    log.error({ err: String(err), purpose, grantId }, 'Bus publish error for vault.secret.generated'),
  );

  log.info({ purpose, grantId }, 'Vault: self-provisioned a new internal secret');

  return value;
}

/**
 * Claim the `(ownerDid, purpose)` provisioning slot via the DB unique
 * constraint (`uniq_internal_secret_provisions_owner_purpose`, migration
 * 0153). Returns true when THIS call won the claim (proceed to generate);
 * false when another process already holds it (poll for its grant instead).
 */
async function claimProvisioning(ownerDid: string, purpose: string, field: string): Promise<boolean> {
  const inserted = await db
    .insert(internalSecretProvisions)
    .values({ id: generateId('isp'), ownerDid, purpose, field })
    .onConflictDoNothing({ target: [internalSecretProvisions.ownerDid, internalSecretProvisions.purpose] })
    .returning({ id: internalSecretProvisions.id });
  return inserted.length > 0;
}

/** Poll for the claim winner's active grant to appear. Throws once POLL_ATTEMPTS is exhausted. */
async function pollForActiveGrant(ownerDid: string, purpose: string): Promise<ActiveInternalSecretGrant> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const grant = await findActiveGrant(ownerDid, purpose);
    if (grant) return grant;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `getInternalSecret: lost the provisioning race for purpose '${purpose}' and the winner's grant never appeared`,
  );
}

/** What a provisions row says about its claim — enough to tell a live race from a stranded row. */
interface ProvisionClaim {
  grantId: string | null;
  createdAt: Date | null;
}

/**
 * The provisions row for `(ownerDid, purpose)` when it is STRANDED (#2446),
 * i.e. can never produce a purpose-tagged grant by itself waiting:
 *   - a grant was recorded, yet no active purpose-tagged grant exists any
 *     more (the caller just looked) — superseded by a pre-fix rotate that
 *     dropped `purpose`, or revoked; or
 *   - no grant was ever recorded and the claim is older than
 *     {@link STALE_CLAIM_MS} — the winner crashed mid-seal.
 * A fresh claim with no grant yet is a LIVE race: undefined, so the caller
 * polls for the winner exactly as before.
 */
async function findStrandedProvision(ownerDid: string, purpose: string): Promise<ProvisionClaim | undefined> {
  const [row] = await db
    .select({ grantId: internalSecretProvisions.grantId, createdAt: internalSecretProvisions.createdAt })
    .from(internalSecretProvisions)
    .where(and(eq(internalSecretProvisions.ownerDid, ownerDid), eq(internalSecretProvisions.purpose, purpose)))
    .limit(1);
  if (!row) return undefined;
  const claim: ProvisionClaim = { grantId: row.grantId ?? null, createdAt: row.createdAt ?? null };
  if (claim.grantId) return claim;
  const ageMs = claim.createdAt instanceof Date ? Date.now() - claim.createdAt.getTime() : 0;
  return ageMs > STALE_CLAIM_MS ? claim : undefined;
}

/**
 * Release the stranded row (only if it is still exactly the row we judged
 * stranded) and re-claim through the normal unique-constraint claim, so a
 * re-provision keeps the one-winner guarantee: of N processes that all saw
 * the same stranded row, one deletes it, and of everyone racing the fresh
 * claim, one wins. Everyone else falls through to polling.
 */
async function reclaimStrandedProvision(
  ownerDid: string,
  purpose: string,
  field: string,
  stranded: ProvisionClaim,
): Promise<boolean> {
  const sameClaim = stranded.grantId
    ? eq(internalSecretProvisions.grantId, stranded.grantId)
    : isNull(internalSecretProvisions.grantId);
  const released = await db
    .delete(internalSecretProvisions)
    .where(and(eq(internalSecretProvisions.ownerDid, ownerDid), eq(internalSecretProvisions.purpose, purpose), sameClaim))
    .returning({ id: internalSecretProvisions.id });
  if (released.length === 0) return false;
  return claimProvisioning(ownerDid, purpose, field);
}

/**
 * The node's own active, unexpired self-grant for `field` (subject ===
 * grantedTo === ownerDid), whatever its purpose — the grant a pre-#2446
 * rotation left behind with `purpose = NULL`, or a hand-imported field's.
 */
async function findSelfGrantForField(
  ownerDid: string,
  field: string,
): Promise<{ id: string; purpose: string | null } | undefined> {
  const rows = await db
    .select({
      id: vaultDelegationGrants.id,
      purpose: vaultDelegationGrants.purpose,
      expiresAt: vaultDelegationGrants.expiresAt,
    })
    .from(vaultDelegationGrants)
    .where(activeGrantTuple({ subject: ownerDid, grantedTo: ownerDid, field }));
  const now = Date.now();
  const live = rows.find((row) => !(row.expiresAt instanceof Date) || row.expiresAt.getTime() > now);
  return live ? { id: live.id, purpose: live.purpose ?? null } : undefined;
}

/** Every OTHER DID holding an active grant of `field` from this node — who a fresh secret would strand. */
async function listExternalGrantees(ownerDid: string, field: string): Promise<string[]> {
  const rows = await db
    .select({ grantedTo: vaultDelegationGrants.grantedTo })
    .from(vaultDelegationGrants)
    .where(
      and(
        eq(vaultDelegationGrants.subject, ownerDid),
        eq(vaultDelegationGrants.field, field),
        eq(vaultDelegationGrants.status, 'active'),
      ),
    );
  return [...new Set(rows.map((row) => row.grantedTo).filter((did) => did !== ownerDid))];
}

/**
 * Re-tag the existing self-grant with `purpose` and point the provisions
 * row at it (#2446 ruling a). `purpose` is an unsigned bookkeeping column,
 * so this is pure bookkeeping: no re-seal, no new key, external grantees
 * untouched. Idempotent under a race — the conditional update only fires on
 * a still-untagged row, and a loser that finds it already tagged adopts
 * whichever grant now carries the purpose.
 */
async function retagSelfGrant(ownerDid: string, purpose: string, grantId: string): Promise<string> {
  const tagged = await db
    .update(vaultDelegationGrants)
    .set({ purpose })
    .where(
      and(
        eq(vaultDelegationGrants.id, grantId),
        eq(vaultDelegationGrants.status, 'active'),
        isNull(vaultDelegationGrants.purpose),
      ),
    )
    .returning({ id: vaultDelegationGrants.id });
  let current: string | undefined = tagged[0]?.id;
  if (!current) {
    current = (await findActiveGrant(ownerDid, purpose))?.grantId;
  }
  if (!current) {
    throw new Error(
      `getInternalSecret: could not re-tag grant '${grantId}' with purpose '${purpose}' — it is no longer an untagged active self-grant`,
    );
  }
  await recordProvisionGrant(ownerDid, purpose, current);
  return current;
}

/**
 * The claim holder's move when no purpose-tagged grant exists — first boot,
 * a manually deleted provisions row, or a stranded one (#2446):
 *
 *   - the field is still readable through the node's own self-grant →
 *     ADOPT it: re-tag that grant with the purpose, repoint the row, keep
 *     the value (one WARN). This is prod's 2026-09-29 state; the kernel
 *     must find *that* secret, not *a* secret.
 *   - reading it fails (tampered entry, invalid grant signature) → the
 *     error surfaces. Never replaced, never regenerated.
 *   - nothing readable (no field, no self-grant, tombstoned) → generate
 *     fresh. If other DIDs still hold grants of the field, they now point
 *     at a key that no longer exists: ERROR naming them — re-granting is an
 *     operator action, never done unattended at boot (#2245 countersign).
 */
async function adoptOrGenerate(
  ownerDid: string,
  purpose: string,
  field: string,
  generate: SecretGenerator,
  stranded: ProvisionClaim | undefined,
): Promise<string> {
  const selfGrant = await findSelfGrantForField(ownerDid, field);
  if (selfGrant) {
    const value = await loadAndUnseal(field);
    if (value !== undefined) {
      const grantId = await retagSelfGrant(ownerDid, purpose, selfGrant.id);
      await ensureSelfGrantNeverExpires(purpose, grantId);
      log.warn(
        { purpose, field, grantId, previousGrantId: stranded?.grantId ?? null },
        'getInternalSecret: no purpose-tagged grant, but the field is readable — re-tagged the existing grant and kept its value (#2446)',
      );
      return value;
    }
  }

  const staleGrantees = await listExternalGrantees(ownerDid, field);
  if (staleGrantees.length > 0) {
    log.error(
      { purpose, field, staleGrantees },
      'getInternalSecret: nothing readable left — generating a fresh secret; these grantees now hold a stale key and must be re-granted by an operator (#2446)',
    );
  } else if (stranded) {
    log.warn(
      { purpose, field, previousGrantId: stranded.grantId },
      'getInternalSecret: stranded provisions row and nothing readable left — generating a fresh secret (#2446)',
    );
  }
  return generateAndSeal(ownerDid, purpose, generate);
}

/** Tamper-class failures: the claim is kept so nothing ever races in to replace the entry. */
function isTamperFailure(err: unknown): boolean {
  return err instanceof VaultIntegrityError || err instanceof VaultDelegationError;
}

/**
 * Run `provision` as the holder of the `(ownerDid, purpose)` claim, rolling
 * the claim back on an ordinary failure WE observed so this process (or
 * another) can retry immediately instead of waiting on a stale row. A
 * tamper-class failure keeps the claim (#2446): deleting it would let the
 * next caller win a fresh claim and paper over the tampered entry with a
 * new secret. A hard crash between claiming and this catch running (e.g.
 * SIGKILL) can still leave a claim behind — {@link findStrandedProvision}
 * re-claims it once it is stale.
 */
async function provisionAsClaimHolder(
  ownerDid: string,
  purpose: string,
  provision: () => Promise<string>,
): Promise<string> {
  try {
    return await provision();
  } catch (err) {
    if (!isTamperFailure(err)) {
      await db
        .delete(internalSecretProvisions)
        .where(and(eq(internalSecretProvisions.ownerDid, ownerDid), eq(internalSecretProvisions.purpose, purpose)))
        .catch(() => undefined);
    }
    throw err;
  }
}

async function resolveInternalSecret(purpose: string, generate: SecretGenerator): Promise<string> {
  const ownerDid = getNodeSigningIdentity().senderDid;

  const existing = await findActiveGrant(ownerDid, purpose);
  if (existing) {
    // A grant already tagged by a pre-#2451 boot can still carry the expiry a
    // pre-#2446 rotate stamped on it — clear it before it locks the kernel out.
    if (existing.expiresAt) {
      await ensureSelfGrantNeverExpires(purpose, existing.grantId);
    }
    return fetchAndAck(ownerDid, existing.grantId, purpose);
  }

  const field = internalSecretField(purpose);
  if (await claimProvisioning(ownerDid, purpose, field)) {
    return provisionAsClaimHolder(ownerDid, purpose, () => adoptOrGenerate(ownerDid, purpose, field, generate, undefined));
  }

  // #2446: a claim row can outlive its grant. Waiting on it would poll for a
  // winner that does not exist and fail on every request; re-claim instead.
  const stranded = await findStrandedProvision(ownerDid, purpose);
  if (stranded && (await reclaimStrandedProvision(ownerDid, purpose, field, stranded))) {
    return provisionAsClaimHolder(ownerDid, purpose, () => adoptOrGenerate(ownerDid, purpose, field, generate, stranded));
  }

  const winnerGrant = await pollForActiveGrant(ownerDid, purpose);
  return fetchAndAck(ownerDid, winnerGrant.grantId, purpose);
}

/**
 * Resolve a kernel-internal secret for `purpose`, self-provisioning it on
 * first call if no grant exists yet. Cached for the lifetime of the
 * process — see this module's docblock for the full generate/fetch/
 * concurrency contract. Uses the default 32-random-bytes generator; see
 * {@link getOrGenerateInternalSecret} for a structured secret.
 */
export function getInternalSecret(purpose: string): Promise<string> {
  return getOrGenerateInternalSecret(purpose, DEFAULT_SECRET_GENERATOR);
}

/**
 * Like {@link getInternalSecret}, but lets the claim winner supply its own
 * plaintext generator instead of 32 random bytes — e.g. #2291's VAPID
 * keypair (`JSON.stringify({publicKey, privateKey})`), generated once and
 * self-granted the same way, then parsed back out by the caller. A process
 * that loses the provisioning race, or finds an existing grant, always
 * gets back whatever was already generated/fetched — `generate()` is only
 * ever invoked by the winner (see {@link generateAndSeal}), never used to
 * override an existing value.
 */
export function getOrGenerateInternalSecret(purpose: string, generate: SecretGenerator): Promise<string> {
  const cached = secretCache.get(purpose);
  if (cached) return cached;

  watchForRotation(purpose);

  const promise = resolveInternalSecret(purpose, generate).catch((err: unknown) => {
    // Never cache a failed attempt — a transient DB hiccup on first boot
    // must not permanently poison every later call in this process.
    secretCache.delete(purpose);
    throw err;
  });
  secretCache.set(purpose, promise);
  return promise;
}

/**
 * Drop this process's cached value for `purpose`, so the next
 * {@link getInternalSecret} re-resolves the CURRENT grant (#2446 fix 3).
 * Called by rotation directly, and by the vault hot-reload subscription for
 * any rotate/update event on the purpose's field.
 */
export function invalidateInternalSecret(purpose: string): void {
  secretCache.delete(purpose);
}

/**
 * Subscribe (once per purpose per process) to vault rotate/update events for
 * the purpose's field, so a rotation is picked up without a restart. The
 * hot-reload reactor is what turns `vault.secret.rotated` into subscriber
 * callbacks; registering it here makes the wiring self-sufficient rather
 * than depending on some route module having been loaded first.
 */
function watchForRotation(purpose: string): void {
  if (watchedPurposes.has(purpose)) return;
  watchedPurposes.add(purpose);
  ensureVaultHotReloadReactorRegistered();
  subscribeToSecret(internalSecretField(purpose), () => {
    invalidateInternalSecret(purpose);
  });
}

/** Test-only: clears the process-lifetime cache so each test starts clean. */
export function _resetInternalSecretCacheForTests(): void {
  secretCache.clear();
  watchedPurposes.clear();
}
