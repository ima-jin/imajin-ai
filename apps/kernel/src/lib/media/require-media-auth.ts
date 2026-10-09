import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, resolveActingDid, verifyAppToken, type Identity, type Scope } from "@imajin/auth";
import { enforceRoutePolicy, type DelegationRouteKey } from "@imajin/auth/delegation-policy";
import { resolveAppServiceCaller } from "@/src/lib/auth/app-service-caller";

/**
 * The `aud` a scoped app-token must be minted for before these routes will
 * accept it: the kernel's own seeded registry audience, `jin`
 * (migrations/0139_registry_apps_seed_first_party.sql). Registry audiences are
 * slugs, never the node's host (#2706) — the host is shared by every
 * path-routed app, so verifying against it would accept any app's token and no
 * mintable token would ever match it.
 */
export const MEDIA_APP_AUDIENCE = "jin";

export interface MediaAuth {
  /** Effective DID: the resource owner / acting identity for this call. */
  did: string;
  /**
   * The full identity when authenticated via the shared session cookie or a
   * legacy Bearer PAT (`requireAuth`) — carries tier, `actingFor`, etc. Null
   * when authenticated via a scoped app-token (#2393): a token's `sub` IS
   * the resolved user, with no delegation overlay to apply on top of it.
   */
  identity: Identity | null;
}

export type MediaAuthResult = { auth: MediaAuth } | { error: string; status: number };

/**
 * A scoped app-token's outcome: `null` when no such token authenticates this
 * request at all (caller should fall through to `requireAuth`); otherwise the
 * terminal result — either the resolved auth, or a 403 when the token
 * verified but lacks `requiredScope`. A verified-but-under-scoped token is
 * NOT a fall-through case: `requireSessionOrAppToken`'s own `requireScopes`
 * (packages/auth/src/require-session-or-app-token.ts) draws the same line —
 * once a bearer verifies as an app-token, its scopes are authoritative.
 */
async function tryAppTokenAuth(request: NextRequest, requiredScope: Scope): Promise<MediaAuthResult | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const verification = await verifyAppToken(token, { aud: MEDIA_APP_AUDIENCE });
  if (verification) {
    return scopedAuth(verification.sub, verification.scopes, requiredScope);
  }

  // #2747: not a session-app token — it may be the app's OWN service token.
  const serviceCaller = await resolveAppServiceCaller(token);
  if (serviceCaller) {
    return scopedAuth(serviceCaller.appDid, serviceCaller.scopes, requiredScope);
  }
  return null;
}

/** Terminal outcome for a verified token: its `did` as owner, or a 403 when `scopes` lacks `requiredScope`. */
function scopedAuth(did: string, scopes: readonly string[], requiredScope: Scope): MediaAuthResult {
  if (!scopes.includes(requiredScope)) {
    return { error: `Missing required scope: ${requiredScope}`, status: 403 };
  }
  return { auth: { did, identity: null } };
}

/**
 * Authenticate a media route call against EITHER the pre-existing paths
 * (shared session cookie or legacy Bearer PAT, unchanged via `requireAuth`)
 * OR — additively (#2393) — a scoped app-token minted via
 * `POST /auth/api/tokens/app`, the same adapter coffee's `/api/pages/mine`
 * reference-adopted in #1974.
 *
 * `requiredScope` is enforced ONLY on the token path — `media:write` for the
 * four mutation routes, `media:read` for authenticated `GET .../content` —
 * mirroring `requireSessionOrAppToken`'s own `requireScopes`: the shared
 * session cookie predates scoped grants, so there is nothing to enforce on
 * that path (see `MediaAuth.identity`'s doc comment).
 *
 * An app's own `app-service+jwt` (#2747, `POST /auth/api/apps/token/service`)
 * is accepted too, with the same `requiredScope` rule: the caller DID is the
 * app DID (a service token never carries a user), so an asset it uploads is
 * owned by the app. It is tried after the session-app token, which keeps
 * behaving exactly as before.
 *
 * The token path is tried first, same order `requireSessionOrAppToken`
 * itself uses. A bearer that doesn't verify as a scoped app-token AT ALL is
 * not necessarily a dead end — legacy Bearer PATs are also sent as
 * `Authorization: Bearer` — so that case falls through to `requireAuth`
 * rather than failing outright, exactly preserving its existing behavior. A
 * bearer that DOES verify but lacks `requiredScope` is terminal (403) — it
 * never falls through to session auth.
 */
export async function requireMediaAuth(request: NextRequest, requiredScope: Scope): Promise<MediaAuthResult> {
  const tokenResult = await tryAppTokenAuth(request, requiredScope);
  if (tokenResult) return tokenResult;

  const sessionResult = await requireAuth(request);
  if ("error" in sessionResult) {
    return { error: sessionResult.error, status: sessionResult.status };
  }
  return { auth: { did: resolveActingDid(sessionResult.identity), identity: sessionResult.identity } };
}

/** Build the terminal error response for a failed {@link requireMediaAuth} call. */
export function mediaAuthErrorResponse(
  authResult: { error: string; status: number },
  cors?: Record<string, string>,
): NextResponse {
  return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
}

/**
 * Delegation-policy gate for a media mutation (#2360) — the media-route
 * adapter over the blanket `enforceRoutePolicy` helper. `irreversible` /
 * `value-moving` mutations attempted via `X-Acting-For` agent delegation on
 * the session/legacy path get the 403 `AGENT_APPROVAL_REQUIRED` (the agent may
 * propose, the owner must countersign); `reversible` ones pass through.
 *
 * Returns `null` (no gate) when the call isn't under actingFor delegation,
 * which is always true on the scoped app-token path (#2393): a token's `sub`
 * IS the resource owner directly, with no separate delegate identity to gate.
 * `assetId` is kept in the body for existing clients (the generic policy
 * body calls it `resourceId`).
 */
export function mediaDelegationGate(
  auth: MediaAuth,
  key: DelegationRouteKey,
  assetId: string,
  cors?: Record<string, string>,
): Response | null {
  return enforceRoutePolicy(auth.identity, key, { resourceId: assetId, extra: { assetId }, headers: cors });
}
