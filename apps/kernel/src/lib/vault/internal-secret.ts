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
 * never blocked by that failure. Only a hard crash between claiming and
 * that rollback running (e.g. SIGKILL, before any catch can execute)
 * leaves a genuinely stale claim row behind — deliberately out of scope
 * for #2245 (an operator would need to delete that row to unblock a
 * future boot); tracked as a rotate-card follow-up alongside actual
 * rotation.
 *
 * ## Rotation seam (explicitly out of scope for #2245)
 * The lookup always resolves the CURRENT grant for `(subject, grantedTo,
 * purpose)` by filtering on `status = 'active'` — the same
 * supersede-on-rotate semantics already used everywhere else in this
 * vault module (`supersedeGrants`, `insertActiveGrant`). A future rotate
 * card can supersede the active row and insert a fresh one with NO change
 * to this lookup at all.
 *
 * ## Fetch + ack (#2231/#2235/#2257)
 * Reading an EXISTING grant goes through the exact same agent-facing
 * `fetchGrantSecret`/`ackGrant` pair every other purpose-bound grant
 * uses — one deferred `used` ack per fetch, never at fetch time. A
 * freshly GENERATED secret never calls either: there is nothing to fetch,
 * since the plaintext is already in hand from generation.
 */
import { randomBytes, createHash } from 'node:crypto';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { and, eq } from 'drizzle-orm';
import { db, vaultDelegationGrants, internalSecretProvisions } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeSigningIdentity } from './sealing';
import { sealAndGrantStaticSecret, fetchGrantSecret, ackGrant } from './index';

const log = createLogger('kernel');

/** Vault field name holding a self-provisioned internal secret for `purpose`. */
export function internalSecretField(purpose: string): string {
  return `internal-secret:${purpose}`;
}

// Process-lifetime cache: getInternalSecret only ever fetches-or-generates
// once per purpose per process. Caching the in-flight PROMISE (not just the
// resolved value) means concurrent in-process callers for the same purpose
// share one resolution instead of racing each other into the DB.
const secretCache = new Map<string, Promise<string>>();

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
}

/**
 * The CURRENT (`status = 'active'`) self-granted row for
 * `(ownerDid, purpose)`, or undefined when none exists yet — see this
 * module's "Rotation seam" docblock section for why this simple filter is
 * already rotation-safe.
 */
async function findActiveGrant(ownerDid: string, purpose: string): Promise<ActiveInternalSecretGrant | undefined> {
  const [row] = await db
    .select({ grantId: vaultDelegationGrants.id })
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
  return row ? { grantId: row.grantId } : undefined;
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

/** Generate, seal, self-grant, and attest a brand-new internal secret. Only the claim winner calls this. */
async function generateAndSeal(ownerDid: string, purpose: string): Promise<string> {
  const field = internalSecretField(purpose);
  const value = randomBytes(32).toString('hex');

  const { grantId } = await sealAndGrantStaticSecret(field, value, {
    principalDid: ownerDid,
    granteeDid: ownerDid,
    purpose,
    oneTime: false,
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

  await db
    .update(internalSecretProvisions)
    .set({ grantId })
    .where(and(eq(internalSecretProvisions.ownerDid, ownerDid), eq(internalSecretProvisions.purpose, purpose)));

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

async function resolveInternalSecret(purpose: string): Promise<string> {
  const ownerDid = getNodeSigningIdentity().senderDid;

  const existing = await findActiveGrant(ownerDid, purpose);
  if (existing) {
    return fetchAndAck(ownerDid, existing.grantId, purpose);
  }

  const field = internalSecretField(purpose);
  const won = await claimProvisioning(ownerDid, purpose, field);
  if (won) {
    try {
      return await generateAndSeal(ownerDid, purpose);
    } catch (err) {
      // Roll back our own claim on a failure WE observed, so this process
      // (or another) can retry immediately instead of waiting on a stale
      // row. Only a hard crash between claiming and this catch running
      // (e.g. SIGKILL) can still leave a stale claim behind — deliberately
      // out of scope for #2245, tracked as a rotate-card follow-up (see
      // this module's docblock).
      await db
        .delete(internalSecretProvisions)
        .where(and(eq(internalSecretProvisions.ownerDid, ownerDid), eq(internalSecretProvisions.purpose, purpose)))
        .catch(() => undefined);
      throw err;
    }
  }

  const winnerGrant = await pollForActiveGrant(ownerDid, purpose);
  return fetchAndAck(ownerDid, winnerGrant.grantId, purpose);
}

/**
 * Resolve a kernel-internal secret for `purpose`, self-provisioning it on
 * first call if no grant exists yet. Cached for the lifetime of the
 * process — see this module's docblock for the full generate/fetch/
 * concurrency contract.
 */
export function getInternalSecret(purpose: string): Promise<string> {
  const cached = secretCache.get(purpose);
  if (cached) return cached;

  const promise = resolveInternalSecret(purpose).catch((err: unknown) => {
    // Never cache a failed attempt — a transient DB hiccup on first boot
    // must not permanently poison every later call in this process.
    secretCache.delete(purpose);
    throw err;
  });
  secretCache.set(purpose, promise);
  return promise;
}

/** Test-only: clears the process-lifetime cache so each test starts clean. */
export function _resetInternalSecretCacheForTests(): void {
  secretCache.clear();
}
