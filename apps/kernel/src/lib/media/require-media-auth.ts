import type { NextRequest } from "next/server";
import { requireAuth, resolveActingDid, verifyAppToken, type Identity } from "@imajin/auth";
import { nodeUrl } from "@/src/lib/http/node-url";

/**
 * This node's own host — the `aud` a scoped app-token must be minted for
 * before these routes will accept it. Mirrors coffee's `thisAppHost()`
 * reference adoption (#1974) exactly, just resolving THIS app's (kernel's)
 * own origin via the existing `nodeUrl()` single source of truth instead of
 * re-deriving it from `NEXT_PUBLIC_BASE_URL` a second time.
 */
function mediaAppAudience(): string {
  try {
    return new URL(nodeUrl()).host;
  } catch {
    return "jin.imajin.ai";
  }
}

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

/** A scoped app-token's `sub`, or null when no such token authenticates this request. */
async function tryAppTokenAuth(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const verification = await verifyAppToken(authHeader.slice(7), { aud: mediaAppAudience() });
  return verification?.sub ?? null;
}

/**
 * Authenticate a media route call against EITHER the pre-existing paths
 * (shared session cookie or legacy Bearer PAT, unchanged via `requireAuth`)
 * OR — additively (#2393) — a scoped app-token minted via
 * `POST /auth/api/tokens/app`, the same adapter coffee's `/api/pages/mine`
 * reference-adopted in #1974.
 *
 * The token path is tried first, same order `requireSessionOrAppToken`
 * itself uses. A bearer that doesn't verify as a scoped app-token is not
 * necessarily a dead end — legacy Bearer PATs are also sent as
 * `Authorization: Bearer` — so that case falls through to `requireAuth`
 * rather than failing outright, exactly preserving its existing behavior.
 */
export async function requireMediaAuth(request: NextRequest): Promise<MediaAuthResult> {
  const tokenSub = await tryAppTokenAuth(request);
  if (tokenSub) {
    return { auth: { did: tokenSub, identity: null } };
  }

  const sessionResult = await requireAuth(request);
  if ("error" in sessionResult) {
    return { error: sessionResult.error, status: sessionResult.status };
  }
  return { auth: { did: resolveActingDid(sessionResult.identity), identity: sessionResult.identity } };
}
