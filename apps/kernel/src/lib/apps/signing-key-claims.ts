/**
 * App signing-key claim codes (#2411).
 *
 * `apps.provision` mints a third-party app's signing key IN the vault and
 * grants it to the app's own DID (`grantExistingMintedKey`, purpose
 * `app-signing-key`), but the app has no pre-existing identity to
 * authenticate that grant's fetch with — unlike a first-party service
 * (corpus, #2243), which already holds a hand-provisioned bootstrap keypair
 * on its own box. Ryan's 2026-09-27 ruling on #2411 (rec (a)): the operator
 * approval that mints the grant ALSO emits a one-time, short-TTL claim code,
 * shown exactly once on the /jin card. The app exchanges that code — the
 * only credential its `.env.local` ever carries — for its signing key at
 * first boot via `POST /api/apps/claim`.
 *
 * ## Never holds secret material
 * `code_hash` is a SHA-256 digest of the plaintext code. The plaintext
 * itself is generated in-process, returned exactly once from
 * {@link issueSigningKeyClaim} to its caller (the apps-provision execution
 * bridge, which surfaces it — and ONLY it — in the operator-approval
 * decision response's one-time `data` reveal, same posture as #2252's
 * bearer plaintext), and is never logged, never part of any bus event, and
 * never re-derivable from the stored row.
 *
 * ## Single-use, short TTL
 * A claim code authenticates exactly one exchange. {@link claimSigningKey}
 * atomically transitions `status: 'pending' -> 'claimed'` (a
 * `WHERE status = 'pending'` guard, mirroring `fetchGrantSecret`'s one-time
 * grant claim in `../vault/index.ts`), so two concurrent redemptions of the
 * same code can never both succeed. A second exchange attempt — whether the
 * code was already claimed or has simply expired — is refused, never
 * silently re-served.
 *
 * ## Re-issuing
 * Every successful `apps.provision` execution (fresh or idempotent-retry —
 * see `../apps/provision.ts`) issues a FRESH claim code and expires any
 * still-pending prior one for the same app DID. This is the operator's
 * lever for a lost/expired code: re-propose and re-approve `apps.provision`
 * for the same slug (see `POST /api/apps/provision`'s `reissueClaim` flag)
 * to get a new one-time code without re-minting the key or re-creating the
 * repo.
 *
 * ## Bootstrap-key binding (restart authentication)
 * The claim code alone only ever authenticates ONE exchange (first boot).
 * To avoid needing a fresh operator-approved code on every later restart,
 * the app mints its OWN Ed25519 "bootstrap" keypair, persists it in a local
 * keystore file (never the actual signing key — see
 * `@ima-jin/auth-client`'s `loadAppSigningKey`), and submits the PUBLIC
 * half alongside the claim code. {@link claimSigningKey} binds that public
 * key to the claim row. Every later boot re-authenticates by signing a
 * fresh challenge with the bootstrap private key — verified by
 * `../apps/bootstrap-fetch-auth.ts` against the bound public key — instead
 * of spending a claim code. Re-issuing (rebinding, e.g. a lost keystore)
 * revokes the previously bound key: {@link claimSigningKey} calls
 * {@link revokeBootstrapBindingsForAppDid} on every successful claim, so at
 * most one bootstrap key is ever trusted per app at a time.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, appSigningKeyClaims, type AppSigningKeyClaimRow } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';

const log = createLogger('kernel:apps:signing-key-claims');

/** Purpose bound to the delegation grant a claim code authorizes fetching. */
export const APP_SIGNING_KEY_PURPOSE = 'app-signing-key';

/** How long a freshly issued claim code remains redeemable. */
const CLAIM_CODE_TTL_MS = 15 * 60 * 1000;

/** SHA-256 hex digest — deterministic, one-way, never reversible to the plaintext code. */
function hashClaimCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** A fresh, high-entropy, URL-safe plaintext claim code. Never logged, never persisted verbatim. */
function generateClaimCode(): string {
  return `claim_${randomBytes(24).toString('base64url')}`;
}

/**
 * Expire every still-`pending` claim for `appDid` other than the one being
 * issued now — at most one live, redeemable code should exist per app at a
 * time, so a prior unclaimed code from an earlier `apps.provision` retry
 * can never be redeemed after a fresh one has been issued.
 */
async function expirePendingClaimsForAppDid(appDid: string): Promise<void> {
  await db
    .update(appSigningKeyClaims)
    .set({ status: 'expired' })
    .where(and(eq(appSigningKeyClaims.appDid, appDid), eq(appSigningKeyClaims.status, 'pending')));
}

function emitClaimIssuedEvent(nodeDid: string, slug: string, appDid: string, grantId: string): void {
  publish('apps.signing-key.claim.issued', {
    issuer: nodeDid,
    subject: appDid,
    scope: 'apps',
    payload: { slug, appDid, grantId, context_id: appDid, context_type: 'apps.signing-key' },
  }).catch((err: unknown) => log.error({ err: String(err), slug, appDid }, 'Bus publish error for apps.signing-key.claim.issued'));
}

/**
 * Issue a fresh one-time claim code for `appDid`'s `grantId`, expiring any
 * still-pending prior code for the same app first. Returns the PLAINTEXT
 * code — the only time it will ever exist outside this function's stack.
 */
export async function issueSigningKeyClaim(params: {
  nodeDid: string;
  slug: string;
  appDid: string;
  grantId: string;
}): Promise<string> {
  const { nodeDid, slug, appDid, grantId } = params;

  await expirePendingClaimsForAppDid(appDid);

  const code = generateClaimCode();
  await db.insert(appSigningKeyClaims).values({
    id: generateId('asck'),
    slug,
    appDid,
    grantId,
    codeHash: hashClaimCode(code),
    status: 'pending',
    expiresAt: new Date(Date.now() + CLAIM_CODE_TTL_MS),
  });

  emitClaimIssuedEvent(nodeDid, slug, appDid, grantId);
  log.info({ slug, appDid, grantId }, 'apps.provision: issued a fresh app-signing-key claim code');

  return code;
}

export type ClaimSigningKeyOutcome =
  | { status: 'ok'; slug: string; appDid: string; grantId: string }
  | { status: 'not_found' | 'expired' | 'already_claimed' };

/**
 * Revoke every currently-active bootstrap-key binding for `appDid` other
 * than `exceptRowId` (when given). Called on every successful
 * {@link claimSigningKey} so rebinding (operator re-approving
 * `apps.provision` with `reissueClaim: true` after a lost keystore) leaves
 * at most one trusted bootstrap key per app — the previous key can never
 * again authenticate a fetch, even though its own claim row's `status`
 * stays `'claimed'` as the historical record.
 */
export async function revokeBootstrapBindingsForAppDid(appDid: string, exceptRowId?: string): Promise<void> {
  const scope = [
    eq(appSigningKeyClaims.appDid, appDid),
    isNotNull(appSigningKeyClaims.bootstrapPublicKey),
    isNull(appSigningKeyClaims.bootstrapKeyRevokedAt),
  ];
  await db
    .update(appSigningKeyClaims)
    .set({ bootstrapKeyRevokedAt: new Date() })
    .where(exceptRowId ? and(...scope, ne(appSigningKeyClaims.id, exceptRowId)) : and(...scope));
}

/**
 * Redeem a plaintext claim code: looks it up by its hash, checks it hasn't
 * expired or already been claimed, and atomically flips it to `'claimed'`
 * while binding the app's bootstrap public key. Any other currently-active
 * bootstrap binding for the same app DID is revoked in the same call
 * (rebinding after a lost keystore, or the ordinary first-ever claim where
 * there is nothing to revoke).
 *
 * Never throws for an ordinary refusal — every outcome is a `status` value
 * so the route layer can respond and audit uniformly. `hostHint` is a
 * caller-reported, best-effort label (e.g. hostname) recorded for the /jin
 * timeline only — never trusted for authorization. `bootstrapPublicKey` is
 * assumed already shape-validated (hex Ed25519 public key) by the route.
 */
export async function claimSigningKey(params: {
  code: string;
  bootstrapPublicKey: string;
  hostHint?: string | null;
}): Promise<ClaimSigningKeyOutcome> {
  const codeHash = hashClaimCode(params.code);

  const [row] = await db
    .select()
    .from(appSigningKeyClaims)
    .where(eq(appSigningKeyClaims.codeHash, codeHash))
    .limit(1);
  if (!row) {
    return { status: 'not_found' };
  }
  if (row.status === 'claimed') {
    return { status: 'already_claimed' };
  }
  if (row.status === 'expired' || row.expiresAt.getTime() <= Date.now()) {
    // Lazily flip a lapsed-but-still-'pending' row to 'expired' so the
    // /jin timeline reflects reality even if no exchange attempt ever
    // triggers the cron-equivalent sweep this table doesn't have (a claim
    // code's TTL is short enough that a dedicated sweep isn't warranted).
    if (row.status !== 'expired') {
      await db.update(appSigningKeyClaims).set({ status: 'expired' }).where(eq(appSigningKeyClaims.id, row.id));
    }
    return { status: 'expired' };
  }

  const claimed = await db
    .update(appSigningKeyClaims)
    .set({
      status: 'claimed',
      claimedAt: new Date(),
      claimedByHost: params.hostHint ?? null,
      bootstrapPublicKey: params.bootstrapPublicKey,
    })
    .where(and(eq(appSigningKeyClaims.id, row.id), eq(appSigningKeyClaims.status, 'pending')))
    .returning({ id: appSigningKeyClaims.id });
  if (claimed.length === 0) {
    // Lost the race to a concurrent redemption of the same code.
    return { status: 'already_claimed' };
  }

  await revokeBootstrapBindingsForAppDid(row.appDid, row.id);

  return { status: 'ok', slug: row.slug, appDid: row.appDid, grantId: row.grantId };
}

export interface BootstrapBinding {
  slug: string;
  appDid: string;
  grantId: string;
  boundPublicKey: string;
}

/**
 * Resolve the currently-active bootstrap-key binding for `appDid`, if any
 * — the claim row whose `bootstrapPublicKey` is set and not yet revoked.
 * Used by `../apps/bootstrap-fetch-auth.ts` on every subsequent-boot fetch.
 * Returns `null` when the app has never completed a claim exchange, or its
 * only binding has been revoked (rebound elsewhere).
 */
export async function resolveActiveBootstrapBinding(appDid: string): Promise<BootstrapBinding | null> {
  const rows = await db
    .select()
    .from(appSigningKeyClaims)
    .where(
      and(
        eq(appSigningKeyClaims.appDid, appDid),
        eq(appSigningKeyClaims.status, 'claimed'),
        isNotNull(appSigningKeyClaims.bootstrapPublicKey),
        isNull(appSigningKeyClaims.bootstrapKeyRevokedAt),
      ),
    )
    .orderBy(desc(appSigningKeyClaims.claimedAt))
    .limit(1);

  const row = rows[0];
  if (!row?.bootstrapPublicKey) {
    return null;
  }
  return { slug: row.slug, appDid: row.appDid, grantId: row.grantId, boundPublicKey: row.bootstrapPublicKey };
}

/** Current status for a slug's most recent claim — used by tests/diagnostics only. */
export async function getLatestSigningKeyClaimForSlug(slug: string): Promise<AppSigningKeyClaimRow | undefined> {
  const rows = await db
    .select()
    .from(appSigningKeyClaims)
    .where(eq(appSigningKeyClaims.slug, slug))
    .orderBy(appSigningKeyClaims.createdAt);
  return rows.at(-1);
}
