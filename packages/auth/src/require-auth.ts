import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@imajin/config";
import type { Identity, AuthResult, AuthError } from "./types";

const getAuthUrl = () => process.env.AUTH_SERVICE_URL!;

/**
 * This node's public origin, for the onboarding discovery pointer added to
 * 401/403 error bodies (#1899). Mirrors apps/kernel's `nodeUrl()` resolution
 * order exactly (`APP_URL` -> `NEXT_PUBLIC_BASE_URL` -> service-prefix
 * convention) so the URL this package hands back always matches the one the
 * agent card itself advertises. Duplicated rather than imported: this
 * package must not depend on apps/kernel (same package-boundary rule as
 * packages/bus, which must not import apps/kernel either).
 */
function nodeOrigin(): string {
  const explicit = process.env.APP_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (explicit) {
    try {
      const { origin } = new URL(explicit);
      if (origin !== "null") return origin;
    } catch {
      // Malformed env var — fall through to the service-prefix convention.
    }
  }
  const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX ?? "https://";
  const domain = process.env.NEXT_PUBLIC_DOMAIN ?? "imajin.ai";
  const scheme = prefix.startsWith("http://") ? "http" : "https";
  const prefixHost = stripTrailingSlashes(prefix.replace(/^https?:\/\//, ""));
  const host = prefixHost.includes(".") ? prefixHost : domain;
  return `${scheme}://${host}`;
}

/**
 * Trim trailing slashes without a regex — `/\/+$/` was flagged as
 * super-linear on attacker-controlled input (SonarCloud typescript:S8786).
 * `NEXT_PUBLIC_SERVICE_PREFIX` is operator-configured, not request input,
 * but this is just as clear and has no backtracking risk at all.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/** URL of this node's agent card — see {@link nodeOrigin} for why it is derived here. */
export function agentCardUrl(): string {
  return `${nodeOrigin()}/.well-known/agent.json`;
}

/**
 * Build the standard JSON error response for an {@link AuthError} returned by
 * `requireAuth()` / `requireHardDID()` (#1899). Every rejection carries an
 * `onboarding` pointer to the agent card so a caller — human or a stranger's
 * agent holding an unknown or ungranted key — learns how to become a known
 * one, without changing the status code or weakening the underlying check.
 */
export function authErrorResponse(authError: AuthError): NextResponse {
  return NextResponse.json(
    { error: authError.error, onboarding: agentCardUrl() },
    { status: authError.status },
  );
}

/** Parse a single cookie value from a raw Cookie header string */
function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export interface AuthOptions {
  verifyChain?: boolean; // If true, also verify the chain is valid (not just session)
  service?: string;      // If set, validate that acting-as controller has access to this service
  permissions?: string[]; // If set, restrict what acting-as roles can do (e.g. ['read'])
}

/**
 * Extract session cookie value from a cookie header string.
 */
function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const match = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) return null;
  return match.split("=")[1] || null;
}

/**
 * Validate a session cookie against auth service.
 */
async function validateSessionCookie(
  token: string
): Promise<AuthResult | AuthError> {
  try {
    const response = await fetch(`${getAuthUrl()}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      cache: "no-store",
    });

    if (!response.ok) {
      return { error: "Invalid or expired session", status: 401 };
    }

    const data = await response.json();
    const identity: Identity = {
      id: data.did || data.identity?.did || data.identity?.id,
      scope: data.scope || data.identity?.scope || "actor",
      subtype: data.subtype || data.identity?.subtype || undefined,
      name: data.name || data.identity?.name,
      handle: data.handle || data.identity?.handle,
      tier: data.tier || data.identity?.tier || "soft",
    };

    if (!identity.id) {
      return { error: "Invalid session data", status: 401 };
    }

    return { identity };
  } catch (error) {
    log.error({ err: String(error) }, "[AUTH] Session validation failed");
    return { error: "Auth service unavailable", status: 503 };
  }
}

/**
 * Validate a Bearer token against auth service.
 */
async function validateBearerToken(
  token: string
): Promise<AuthResult | AuthError> {
  try {
    const response = await fetch(`${getAuthUrl()}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { error: "Invalid or expired token", status: 401 };
    }

    const data = await response.json();
    if (!data.valid || !data.identity) {
      return { error: "Invalid token", status: 401 };
    }

    return { identity: data.identity };
  } catch (error) {
    log.error({ err: String(error) }, "[AUTH] Token validation failed");
    return { error: "Auth service unavailable", status: 503 };
  }
}

interface ActingAsResult {
  valid: boolean;
  role?: string;                     // e.g. 'owner', 'admin', 'agent'
  allowedServices?: string[] | null; // null = full access
}

/**
 * Validate that a caller is an active owner or admin controller of a group DID.
 * Optionally checks if the controller has access to a specific service.
 * Uses the internal API to avoid recursive auth checks.
 */
async function validateActingAs(
  callerDid: string,
  groupDid: string,
  service?: string
): Promise<ActingAsResult> {
  const authUrl = getAuthUrl();
  const internalApiKey = process.env.ATTESTATION_INTERNAL_API_KEY;
  if (!internalApiKey) {
    log.warn({}, "[AUTH] ATTESTATION_INTERNAL_API_KEY not set — cannot validate act-as");
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
    if (data.valid !== true || !["owner", "admin", "maintainer", "agent"].includes(data.role)) {
      return { valid: false };
    }

    const allowedServices: string[] | null = data.allowedServices ?? null;

    // If a service is specified and the controller has a restricted list, check it
    if (service && allowedServices && allowedServices.length > 0) {
      if (!allowedServices.includes(service)) {
        return { valid: false };
      }
    }

    return { valid: true, role: data.role, allowedServices };
  } catch (err) {
    log.error({ err: String(err) }, "[AUTH] Act-as validation failed");
    return { valid: false };
  }
}

/**
 * Require authentication. Checks session cookie first, then Bearer token.
 * Also handles X-Acting-As header for group identity impersonation.
 *
 * Works with both `Request` and `NextRequest`.
 */
export async function requireAuth(
  request: Request,
  options?: AuthOptions
): Promise<AuthResult | AuthError> {
  // Try session cookie first
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = extractSessionCookie(cookieHeader);

  let result: AuthResult | AuthError;
  if (sessionToken) {
    result = await validateSessionCookie(sessionToken);
  } else {
    // Fall back to Bearer token
    const auth = request.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      result = await validateBearerToken(auth.slice(7));
    } else {
      return { error: "Not authenticated", status: 401 };
    }
  }

  if (options?.verifyChain && "identity" in result && result.identity) {
    try {
      const chainRes = await fetch(
        `${getAuthUrl()}/api/identity/${encodeURIComponent(result.identity.id)}/verify`
      );
      if (chainRes.ok) {
        const chainData = await chainRes.json();
        result.identity.chainVerified = chainData.chain?.valid ?? false;
      } else {
        result.identity.chainVerified = false;
      }
    } catch (err) {
      log.error({ err: String(err) }, "[AUTH] Chain verification failed");
      result.identity.chainVerified = false;
    }
  }

  // Handle X-Acting-As header or cookie for group identity impersonation
  if ("identity" in result && result.identity) {
    const actingAs = request.headers.get("x-acting-as")
      || (request as { cookies?: { get?: (name: string) => { value?: string } | undefined } }).cookies?.get?.("x-acting-as")?.value
      || parseCookieValue(request.headers.get("cookie"), "x-acting-as");
    if (actingAs) {
      const actingAsResult = await validateActingAs(
        result.identity.id,
        actingAs,
        options?.service
      );
      if (!actingAsResult.valid) {
        return { error: "Not authorized to act as this group", status: 403 };
      }
      result.identity.actingAs = actingAs;
      result.identity.actingAsRole = actingAsResult.role;
      result.identity.actingAsServices = actingAsResult.allowedServices ?? undefined;
    }
  }

  // Handle X-Acting-For header for agent delegation (separate from group acting-as)
  if ("identity" in result && result.identity) {
    const actingFor = request.headers.get("x-acting-for");
    if (actingFor) {
      const authorized = await resolveAgentDelegationAuthority(
        result.identity.id,
        actingFor,
        options?.service
      );
      if (!authorized) {
        return { error: "Not authorized to act for this identity", status: 403 };
      }
      result.identity.actingFor = actingFor;
      result.identity.actingForRole = 'agent';
    }
  }

  return result;
}

/**
 * Resolve whether `agentDid` may act for `principalDid` under X-Acting-For
 * (#1887 dual-read migration). Calls the same grants-first-with-
 * membership-fallback endpoint kernel's ws-server uses for `register_also`
 * (`/auth/api/internal/verify-delegation`, backed by
 * `apps/kernel/src/lib/auth/agent-authority.ts`), so both call sites move to
 * grants-first resolution together.
 *
 * Falls back to the legacy membership-only check (`validateActingAs`
 * against role='agent') when the dual-read endpoint itself is unreachable
 * or `AUTH_INTERNAL_API_KEY` is unset in this service's environment — a
 * missing/misconfigured key must never turn into an authorization
 * regression for services that haven't been given that secret.
 */
async function resolveAgentDelegationAuthority(
  agentDid: string,
  principalDid: string,
  service?: string
): Promise<boolean> {
  const internalKey = process.env.AUTH_INTERNAL_API_KEY;
  if (internalKey) {
    try {
      const res = await fetch(`${getAuthUrl()}/api/internal/verify-delegation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": internalKey },
        body: JSON.stringify({ agentDid, principalDid }),
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        return data.allowed === true;
      }
      log.warn({ status: res.status }, "[AUTH] verify-delegation call failed — falling back to legacy membership check");
    } catch (err) {
      log.error({ err: String(err) }, "[AUTH] verify-delegation call errored — falling back to legacy membership check");
    }
  }

  // Legacy fallback path (pre-#1887): unscoped role='agent' membership check.
  const legacy = await validateActingAs(agentDid, principalDid, service);
  return legacy.valid && legacy.role === 'agent';
}
