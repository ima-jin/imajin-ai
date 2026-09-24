/**
 * Self-only guard for the /jin confirm rail (#2359).
 *
 * The ruling this implements: **act-as must not reach the confirm rail.**
 * A write-approval endpoint — confirm, deny, withdraw, or any other
 * countersignature of a proposal — is authorized against the *real*
 * authenticated session identity (`identity.id`), never against
 * `resolveActingDid(identity)`. Borrowing another DID (an agent holding
 * `X-Acting-For`, or a human carrying the `x-acting-as` cookie the
 * IdentitySwitcher sets) is refused outright with 403
 * `act_as_not_permitted`, rather than silently countersigning on a
 * borrowed identity's behalf.
 *
 * Two findings drove this (#2359):
 *   1. `isOperatorIdentity` only ever excluded `actingFor`, so an operator
 *      session carrying `x-acting-as: <group DID>` sailed straight through
 *      the decide gate — `identity.id` still equalled the operator DID.
 *   2. Nothing on /jin told the operator they were in act-as at the moment
 *      they approved a write (see `app/jin/act-as-banner.tsx`).
 *
 * READ surfaces are deliberately untouched: `GET /jin/api/operator-approvals`
 * still lists under act-as (see {@link actAsContext}, which the list route
 * returns so the panel can render its controls disabled with an
 * explanation instead of pretending the queue is empty).
 *
 * Rails that genuinely DO permit acting-for are out of scope and unchanged
 * — they already record honesty via `resolveComposedBy` (e.g.
 * `src/lib/vault/mint-authority.ts`, which carries the real signer DID
 * alongside the owner it acted for).
 */
import { NextResponse } from 'next/server';
import { isUnderActAs, resolveActingDid, type Identity } from '@imajin/auth';

/** Machine-readable error code every act-as refusal on the confirm rail carries. */
export const ACT_AS_NOT_PERMITTED = 'act_as_not_permitted';

/** Human-readable counterpart to {@link ACT_AS_NOT_PERMITTED}, shown verbatim in the /jin flash. */
export const ACT_AS_NOT_PERMITTED_MESSAGE =
  'Approvals are self-only: drop act-as and decide as yourself. This proposal can only be countersigned by the identity that signed in.';

/** Who is signed in vs. who they are currently acting as — non-null only under act-as. */
export interface ActAsContext {
  /** The real authenticated session DID — the only identity that may countersign. */
  sessionDid: string;
  /** The DID this request would otherwise be attributed to. */
  actingDid: string;
}

/**
 * The act-as overlay on an authenticated identity, or `null` when the
 * caller is plainly themselves. Read surfaces hand this to the client so
 * the UI can explain *why* a control is disabled instead of just hiding
 * it.
 */
export function actAsContext(identity: Identity): ActAsContext | null {
  if (!isUnderActAs(identity)) return null;
  return { sessionDid: identity.id, actingDid: resolveActingDid(identity) };
}

/**
 * The 403 a write-approval endpoint returns when it is called under
 * act-as, or `null` when the caller may proceed to the ownership check.
 *
 * Deliberately evaluated BEFORE the owner comparison: the refusal is about
 * the borrowed identity, not about the proposal, so it never reveals
 * whether a given `proposalId` exists — the same non-disclosure posture
 * the operator check already keeps.
 */
export function actAsRefusal(identity: Identity, cors: HeadersInit): NextResponse | null {
  const context = actAsContext(identity);
  if (!context) return null;
  return NextResponse.json(
    { error: ACT_AS_NOT_PERMITTED_MESSAGE, code: ACT_AS_NOT_PERMITTED, ...context },
    { status: 403, headers: cors },
  );
}
