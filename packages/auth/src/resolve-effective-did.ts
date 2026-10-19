import { resolveComposedBy } from "./acting-did";
import { requireAppAuth } from "./require-app-auth";
import { requireAuth } from "./require-auth";
import type { Scope } from "./scopes";

export type EffectiveDidResult =
  | {
      ok: true;
      effectiveDid: string;
      via: "app" | "session";
      /**
       * The agent DID that composed the request under `X-Acting-For`
       * delegation, or null when the effective DID composed it directly
       * (#1673). App-token callers are not transcribers — the human still
       * types into the app — so the app path is always null.
       */
      composedBy: string | null;
    }
  | { ok: false; status: number; error: string };

/**
 * Resolve the effective DID from a request, trying app auth first — either
 * the preferred `Authorization: Bearer <app-token>` path (#1069) or the
 * legacy `X-App-DID` + `X-App-Authorization` headers — and falling back to
 * session auth.
 *
 * A bearer that doesn't verify as an app token isn't necessarily a dead end:
 * session JWTs are also sent as `Authorization: Bearer` (see `requireAuth`),
 * so that case falls through to session auth instead of failing outright.
 * The legacy header path has no such ambiguity and its errors are always
 * authoritative (#1812).
 * `service` names the owning service, independently of the app-token scope,
 * so session act-as checks enforce the controller's allowed_services.
 */
export async function resolveEffectiveDid(
  request: Request,
  opts: { scope: Scope; service: string }
): Promise<EffectiveDidResult> {
  // Older JS callers must not bypass the required service option and
  // silently skip controller restrictions.
  if (!opts.service?.trim()) {
    return { ok: false, status: 403, error: "Not authorized to act as this group" };
  }
  const hasAppAuthCandidate =
    Boolean(request.headers.get("x-app-did")) || Boolean(request.headers.get("authorization")?.startsWith("Bearer "));

  if (hasAppAuthCandidate) {
    const appResult = await requireAppAuth(request, { scope: opts.scope });
    if (!("error" in appResult)) {
      return { ok: true, effectiveDid: appResult.appAuth.userDid, via: "app", composedBy: null };
    }
    if (!appResult.notAppToken) {
      return { ok: false, status: appResult.status, error: appResult.error };
    }
    // Bearer present but it isn't an app token — fall through, it may be a
    // session JWT.
  }

  const authResult = await requireAuth(request, { service: opts.service });
  if ("error" in authResult) {
    if (authResult.status === 403) {
      return { ok: false, status: authResult.status, error: authResult.error };
    }
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return {
    ok: true,
    effectiveDid: authResult.identity.actingFor ?? authResult.identity.actingAs ?? authResult.identity.id,
    via: "session",
    composedBy: resolveComposedBy(authResult.identity),
  };
}
