/**
 * Blanket delegation policy for owner-mutation routes (#2360).
 *
 * One rule, one helper, applied to every route that mutates a resource on
 * the owner's behalf. A *delegate* is a registered agent acting under
 * `X-Acting-For` (`Identity.actingFor`); the owner is the DID it acts for.
 *
 *   reversible     — metadata edits that can be undone by the owner (rename,
 *                    folder move, versioned content overwrite, classify).
 *                    A delegate MAY execute these. `actingFor` is only ever
 *                    set after the grants-first delegation check
 *                    (`resolveAgentDelegationAuthority`) succeeded, so "an
 *                    active grant" is already established by the time a
 *                    route sees it.
 *   irreversible   — destroys or discloses something the owner cannot get
 *                    back (delete, .fair upgrade, widening access).
 *   value-moving   — moves money, ownership or attribution (transfer,
 *                    settle, pay, refund, withdraw, split edits).
 *
 * `irreversible` and `value-moving` require the owner's own countersign: a
 * delegate may *propose* (the 403 below carries everything the owner needs
 * to re-issue the call from their own session) but never *execute*.
 *
 * Only agent delegation (`actingFor`) is governed here. Group impersonation
 * (`actingAs`) and scoped app-tokens are separate authority models and are
 * deliberately left untouched — see the PR notes for #2360.
 *
 * This module is a standalone subpath export (`@imajin/auth/delegation-policy`)
 * with no I/O so route tests that mock the `@imajin/auth` root keep working.
 */

import { DELEGATION_ROUTES, type DelegationRouteKey, type MutationClass } from "./delegation-routes";

export { DELEGATION_ROUTES } from "./delegation-routes";
export type { DelegationRouteEntry, DelegationRouteKey, MutationClass } from "./delegation-routes";

/** Stable machine code on the 403 a delegate receives. */
export const AGENT_APPROVAL_REQUIRED = "AGENT_APPROVAL_REQUIRED";

export interface DelegationMutation {
  /** Human/machine action label, e.g. "delete", "transfer", "settle". */
  action: string;
  class: MutationClass;
  /** The resource the mutation targets, echoed back so the owner can act on it. */
  resourceId?: string;
}

/** An authenticated session identity (structural subset of `Identity`). */
export interface IdentitySource {
  id: string;
  actingFor?: string | null;
}

/**
 * The `resolveEffectiveDid` shape. `composedBy` is non-null only for an
 * `X-Acting-For` session — app-token callers are always null.
 */
export interface EffectiveDidSource {
  effectiveDid: string;
  composedBy: string | null;
}

/** `null`/`undefined` = no delegation overlay (e.g. scoped app-token path). */
export type DelegationSource = IdentitySource | EffectiveDidSource | null | undefined;

export interface DelegationPolicyBody {
  error: string;
  code: typeof AGENT_APPROVAL_REQUIRED;
  action: string;
  class: Exclude<MutationClass, "reversible">;
  resourceId?: string;
  ownerDid: string;
  delegateDid?: string;
}

export type DelegationDecision =
  | { allowed: true }
  | { allowed: false; status: 403; body: DelegationPolicyBody };

/** True when the class needs the owner's own countersign. */
export function requiresOwnerCountersign(mutationClass: MutationClass): boolean {
  return mutationClass !== "reversible";
}

interface ResolvedDelegation {
  ownerDid: string;
  delegateDid?: string;
}

function isEffectiveDidSource(source: IdentitySource | EffectiveDidSource): source is EffectiveDidSource {
  return "effectiveDid" in source;
}

/**
 * Normalise either auth shape to "who is the owner, and who is the delegate".
 * Returns null when the call is not under agent delegation. A self-delegation
 * (`actingFor === id`) is the owner acting as themselves, not a delegate.
 */
function resolveDelegation(source: DelegationSource): ResolvedDelegation | null {
  if (!source) return null;
  if (isEffectiveDidSource(source)) {
    if (!source.composedBy || source.composedBy === source.effectiveDid) return null;
    return { ownerDid: source.effectiveDid, delegateDid: source.composedBy };
  }
  if (!source.actingFor || source.actingFor === source.id) return null;
  return { ownerDid: source.actingFor, delegateDid: source.id };
}

/** Pure policy decision — no response construction. */
export function evaluateDelegationPolicy(source: DelegationSource, mutation: DelegationMutation): DelegationDecision {
  if (mutation.class === "reversible") return { allowed: true };

  const delegation = resolveDelegation(source);
  if (!delegation) return { allowed: true };

  return {
    allowed: false,
    status: 403,
    body: {
      error: `Agent delegation does not permit ${mutation.class} operations — the owner must countersign`,
      code: AGENT_APPROVAL_REQUIRED,
      action: mutation.action,
      class: mutation.class,
      ...(mutation.resourceId === undefined ? {} : { resourceId: mutation.resourceId }),
      ownerDid: delegation.ownerDid,
      ...(delegation.delegateDid === undefined ? {} : { delegateDid: delegation.delegateDid }),
    },
  };
}

/**
 * The one route-facing helper. Returns a ready-to-return 403 `Response` when
 * a delegate attempts an owner-countersign mutation, otherwise `null`.
 *
 * `extra` fields (e.g. a route's historical `assetId`) are merged into the
 * body without being able to override the policy fields.
 */
export function enforceDelegationPolicy(
  source: DelegationSource,
  mutation: DelegationMutation,
  options?: { headers?: HeadersInit; extra?: Record<string, unknown> },
): Response | null {
  const decision = evaluateDelegationPolicy(source, mutation);
  if (decision.allowed) return null;
  return Response.json(
    { ...options?.extra, ...decision.body },
    { status: decision.status, headers: options?.headers },
  );
}

/**
 * Route-facing entry point: look the route up in the {@link DELEGATION_ROUTES}
 * registry and apply {@link enforceDelegationPolicy} with its class. Routes
 * name themselves by key, so the class of every governed route lives in one
 * table rather than at each call site.
 */
export function enforceRoutePolicy(
  source: DelegationSource,
  key: DelegationRouteKey,
  options?: { resourceId?: string; headers?: HeadersInit; extra?: Record<string, unknown> },
): Response | null {
  const entry = DELEGATION_ROUTES[key];
  return enforceDelegationPolicy(
    source,
    { action: entry.action, class: entry.class, resourceId: options?.resourceId },
    { headers: options?.headers, extra: options?.extra },
  );
}
