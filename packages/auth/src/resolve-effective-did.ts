import { requireAppAuth } from "./require-app-auth";
import { requireAuth } from "./require-auth";
import type { Scope } from "./scopes";

export type EffectiveDidResult =
  | { ok: true; effectiveDid: string; via: "app" | "session" }
  | { ok: false; status: number; error: string };

/**
 * Resolve the effective DID from a request, trying app auth first (if
 * x-app-did header is present) and falling back to session auth.
 */
export async function resolveEffectiveDid(
  request: Request,
  opts: { scope: Scope }
): Promise<EffectiveDidResult> {
  if (request.headers.get("x-app-did")) {
    const appResult = await requireAppAuth(request, { scope: opts.scope });
    if ("error" in appResult) {
      return { ok: false, status: appResult.status, error: appResult.error };
    }
    return { ok: true, effectiveDid: appResult.appAuth.userDid, via: "app" };
  }

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return {
    ok: true,
    effectiveDid: authResult.identity.actingFor ?? authResult.identity.actingAs ?? authResult.identity.id,
    via: "session",
  };
}
