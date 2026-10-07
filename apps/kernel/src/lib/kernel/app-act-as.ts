/**
 * Act-as (group DID) on scoped app tokens (#2639 / #2644).
 *
 * Ruled: the kernel checks the user's group authority ONCE, at app-token issuance,
 * reusing the existing group-permission gate (`validateActingAs` from
 * `@imajin/auth` — the same one `requireAuth` runs for `x-acting-as`), and the
 * operator approves act-as per app (`registry.apps.act_as_allowed`, off by
 * default). There is no per-request re-check; the token's own expiry bounds
 * staleness.
 *
 * This module holds no authority logic of its own: it composes the operator flag
 * with the existing gate and only ever narrows the result.
 */
import { validateActingAs } from '@imajin/auth';

export const ACT_AS_NOT_APPROVED_ERROR = {
  error: 'act_as_not_approved',
  error_description: 'The operator has not approved act-as for this app.',
} as const;

export const ACT_AS_NOT_AUTHORIZED_ERROR = {
  error: 'act_as_not_authorized',
  error_description: 'Not authorized to act as this group.',
} as const;

export const ACT_AS_INVALID_ERROR = {
  error: 'invalid_act_as',
  error_description: 'actAs must be a non-empty group DID string.',
} as const;

export type MintActAsResult =
  | { actingAs: string | undefined }
  | { refusal: { error: string; error_description: string }; status: 400 | 403 };

/**
 * Decide whether a mint request may carry an act-as claim.
 *
 * - `actAs` absent → no claim, no checks (the mint behaves exactly as before).
 * - malformed → 400.
 * - app not operator-approved for act-as → 403, before any authority lookup.
 * - caller lacks authority over the group (existing `validateActingAs` gate) → 403.
 * - controller is restricted to specific services (`allowedServices`) → 403. An app
 *   audience is not one of those service names, so a restricted controller can't be
 *   reconciled with it; refusing is the narrower reading of the existing gate.
 */
export async function resolveMintActAs(
  actAs: unknown,
  callerDid: string,
  app: { actAsAllowed: boolean },
): Promise<MintActAsResult> {
  if (actAs === undefined || actAs === null) return { actingAs: undefined };
  if (typeof actAs !== 'string' || actAs.trim().length === 0) {
    return { refusal: ACT_AS_INVALID_ERROR, status: 400 };
  }
  if (!app.actAsAllowed) {
    return { refusal: ACT_AS_NOT_APPROVED_ERROR, status: 403 };
  }

  const groupDid = actAs.trim();
  const result = await validateActingAs(callerDid, groupDid);
  if (!result.valid || (result.allowedServices && result.allowedServices.length > 0)) {
    return { refusal: ACT_AS_NOT_AUTHORIZED_ERROR, status: 403 };
  }
  return { actingAs: groupDid };
}
