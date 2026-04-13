import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

import { SESSION_COOKIE_NAME } from "@imajin/config";
import type { Identity } from "./types";

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

export interface SessionOptions {
  service?: string; // If set, validate acting-as controller has access to this service
}

/**
 * Validate that a caller is an active controller of a group DID.
 * Server-side validation — same logic as requireAuth but callable from getSession.
 */
async function validateActingAsCookie(
  callerDid: string,
  groupDid: string,
  service?: string
): Promise<{ valid: boolean; allowedServices?: string[] | null }> {
  const authUrl = getAuthUrl();
  const internalApiKey = process.env.ATTESTATION_INTERNAL_API_KEY;
  if (!internalApiKey) {
    log.warn({}, "[AUTH] ATTESTATION_INTERNAL_API_KEY not set — cannot validate act-as in getSession");
    return { valid: false };
  }
  try {
    const res = await fetch(
      `${authUrl}/api/groups/${encodeURIComponent(groupDid)}/controllers/${encodeURIComponent(callerDid)}`,
      {
        headers: { Authorization: `Bearer ${internalApiKey}` },
        cache: "no-store",
      }
    );
    if (!res.ok) return { valid: false };
    const data = await res.json();
    if (data.valid !== true || (data.role !== "owner" && data.role !== "admin")) {
      return { valid: false };
    }

    const allowedServices: string[] | null = data.allowedServices ?? null;
    if (service && allowedServices && allowedServices.length > 0) {
      if (!allowedServices.includes(service)) {
        return { valid: false };
      }
    }

    return { valid: true, allowedServices };
  } catch (err) {
    log.error({ err: String(err) }, "[AUTH] Act-as cookie validation failed");
    return { valid: false };
  }
}

/**
 * Get session for server components (reads from Next.js cookie store).
 * Validates the acting-as cookie server-side — rejects unauthorized scopes.
 *
 * Use in server components and server actions — NOT in API routes
 * (use requireAuth there instead).
 */
export async function getSession(options?: SessionOptions): Promise<Identity | null> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

  if (!sessionCookie) return null;

  try {
    const response = await fetch(`${getAuthUrl()}/api/session`, {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie.value}`,
      },
      cache: "no-store",
    });

    if (!response.ok) return null;

    const data = await response.json();
    const callerDid = data.did;

    const identity: Identity = {
      id: callerDid,
      scope: data.scope || "actor",
      subtype: data.subtype || undefined,
      name: data.name,
      handle: data.handle,
      tier: data.tier || "soft",
    };

    // Validate acting-as cookie server-side (never trust raw cookie value)
    const actingAsCookie = cookieStore.get("x-acting-as")?.value;
    if (actingAsCookie) {
      const result = await validateActingAsCookie(callerDid, actingAsCookie, options?.service);
      if (result.valid) {
        identity.actingAs = actingAsCookie;
        identity.actingAsServices = result.allowedServices ?? undefined;
      }
      // If invalid, silently drop — user sees their own data, not an error
    }

    return identity;
  } catch (error) {
    log.error({ err: String(error) }, "[AUTH] Session fetch failed");
    return null;
  }
}
