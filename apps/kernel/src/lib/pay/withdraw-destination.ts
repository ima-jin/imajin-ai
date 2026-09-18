/**
 * Server-side resolution of the withdrawal payout destination (#2190,
 * hardening #2172).
 *
 * Before this, `POST /api/balance/withdraw` passed a client-supplied
 * `account_id` straight through to the rail as `destination` with no check
 * that it belonged to the acting principal — any authenticated caller could
 * redirect a withdrawal to an arbitrary Stripe Connect account. This module
 * is the single place that decides the real destination: the client
 * SELECTS, the kernel DECIDES.
 *
 * `pay.connected_accounts` (`src/db/schemas/pay.ts`) already persists "which
 * Stripe Connect account does this DID own" for onboarding
 * (`app/pay/api/connect/onboard/route.ts`) — one row per DID (`did` is
 * `.unique()`). That is reused as-is as the source of truth; no migration
 * was needed since today "the DID's default connected account" and "the
 * DID's only connected account" are the same row.
 *
 * Callers must resolve `did` via `resolveActingDid(identity)` *before*
 * calling this — that already picks the acting principal under delegation
 * (`actingFor`/`actingAs`), so a delegate can never target its own
 * connected account, only the principal's.
 */
import { eq } from 'drizzle-orm';
import { db, connectedAccounts } from '@/src/db';

export type WithdrawDestinationResolutionMode = 'default' | 'selected';

export interface ResolvedWithdrawDestination {
  destination: string;
  resolutionMode: WithdrawDestinationResolutionMode;
}

/**
 * `no_connected_account` — `did` has no connected account at all (either no
 * `account_id` was supplied and there's no default, or one was supplied but
 * `did` owns nothing to match it against). Maps to a 4xx, never a 500: this
 * is a caller-fixable state (finish Connect onboarding), not a server error.
 *
 * `forbidden_destination` — `did` has a connected account, but the supplied
 * `account_id` doesn't match it. Maps to 403. Fail closed: never falls back
 * to the supplied value.
 */
export type WithdrawDestinationError = 'no_connected_account' | 'forbidden_destination';

export type WithdrawDestinationResult =
  | ({ ok: true } & ResolvedWithdrawDestination)
  | { ok: false; error: WithdrawDestinationError };

/**
 * Resolve the withdrawal destination for `did` SERVER-SIDE.
 * `requestedAccountId` is untrusted client input — honoured only when it
 * exactly matches `did`'s own connected account's `stripeAccountId`.
 */
export async function resolveWithdrawDestination(
  did: string,
  requestedAccountId: string | undefined,
): Promise<WithdrawDestinationResult> {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.did, did))
    .limit(1);

  if (!requestedAccountId) {
    if (!account) return { ok: false, error: 'no_connected_account' };
    return { ok: true, destination: account.stripeAccountId, resolutionMode: 'default' };
  }

  if (account?.stripeAccountId !== requestedAccountId) {
    return { ok: false, error: 'forbidden_destination' };
  }

  return { ok: true, destination: requestedAccountId, resolutionMode: 'selected' };
}
