import type { NextRequest } from "next/server";

/**
 * Trusted public origin for browser-facing responses (login redirects, etc).
 *
 * The kernel runs behind Caddy, so `request.url` reports the INTERNAL proxy
 * target — `http://localhost:3000` (Next's fallback origin) even when the
 * process listens on :7000 and the browser arrived on
 * `https://jin.imajin.ai`. Redirecting off `request.url` therefore dead-ends
 * every unauthenticated browser at an unreachable `localhost` URL (#1608 for
 * the shared 401 helper; #1185 was the same bug in the MCP OAuth ceremony).
 *
 * Resolution order:
 *   1. `APP_URL` — a RUNTIME env var. Preferred: it is read on every request
 *      rather than inlined into the bundle at build time.
 *   2. `NEXT_PUBLIC_BASE_URL` — the existing node-root convention (see
 *      media/routes/access.ts, media/settle.ts). Build-time inlined by Next,
 *      so it silently resolves to `undefined` in a build that did not have it
 *      set — which is why (1) exists.
 *   3. `request.url`'s origin — correct for local dev, where the browser talks
 *      to the Next dev server directly with no proxy in front.
 *
 * {@link publicOrigin} deliberately does NOT consult `Host` /
 * `X-Forwarded-Host`. Those are client-controlled, and trusting them to build
 * a redirect origin turns every 401 into a Host-header open redirect. A
 * trusted env var has no such surface. {@link proxyAwarePublicOrigin} (#2363)
 * is the narrow exception — see its own doc for the threat model that makes
 * the forwarded headers acceptable there and nowhere else.
 */

/**
 * Normalise a configured base URL down to a bare origin, or null if unusable.
 *
 * Exported so the machine-readable discovery documents (`nodeUrl()`) normalise
 * configured origins exactly the same way this module's redirects do.
 */
export function toOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    // `.origin` strips any path (`.../chat`), trailing slash, and — critically —
    // guarantees we never carry a stale explicit port into the redirect. Mutating
    // `.host` on a parsed URL does NOT clear an existing port, which is how
    // `mcp.imajin.ai:3000` once leaked into a login `next=` (#1185).
    const { origin } = new URL(value);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** The configured node origin, from either env var, or null when neither is set. */
function configuredOrigin(): string | null {
  return toOrigin(process.env.APP_URL) ?? toOrigin(process.env.NEXT_PUBLIC_BASE_URL);
}

/** The origin browser-facing redirects should be anchored to. */
export function publicOrigin(request: NextRequest): string {
  return configuredOrigin() ?? new URL(request.url).origin;
}

/**
 * A hostname (optionally `:port`) and nothing else.
 *
 * Length-bounded (RFC 1035 caps a DNS name at 253 chars) and free of nested
 * quantifiers, so it cannot be driven into pathological backtracking by a
 * hostile header. Anything with a scheme, path, credentials, whitespace, or
 * control characters fails to match and is discarded rather than sanitised —
 * the only shape we accept is the one Caddy actually emits.
 */
const FORWARDED_HOST_PATTERN = /^[a-zA-Z0-9.-]{1,253}(?::\d{1,5})?$/;

/**
 * First value of a header a proxy chain may have comma-joined
 * (`x-forwarded-host: public.example, inner.example`), trimmed, or null when
 * the header is absent or empty. The first entry is the outermost hop — the
 * host the browser actually typed.
 */
function firstForwardedValue(raw: string | null): string | null {
  if (raw === null) return null;
  const first = raw.split(",")[0].trim();
  return first.length > 0 ? first : null;
}

/**
 * The origin the reverse proxy says the browser arrived on, or null when the
 * request carries no usable `X-Forwarded-Host`.
 *
 * `X-Forwarded-Proto` picks the scheme; it defaults to `https` when absent,
 * because a request that reached us through a proxy at all is a deployed one,
 * and downgrading a deployed redirect to `http` is the worse failure. Only a
 * literal `http` opts out.
 */
export function forwardedOrigin(request: NextRequest): string | null {
  const host = firstForwardedValue(request.headers.get("x-forwarded-host"));
  if (host === null || !FORWARDED_HOST_PATTERN.test(host)) return null;

  const proto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const scheme = proto === "http" ? "http" : "https";
  return toOrigin(`${scheme}://${host}`);
}

/**
 * Like {@link publicOrigin}, but falls back to the reverse proxy's
 * `X-Forwarded-Host` / `X-Forwarded-Proto` before `request.url` (#2363).
 *
 * For a deployment behind Caddy with neither env var set, `publicOrigin`'s
 * last resort — `request.url` — is the upstream `localhost:<port>` origin, so
 * every redirect built on it lands the browser somewhere unreachable. The
 * forwarded headers carry the host the browser actually used, which is the
 * only remaining source of that information.
 *
 * Trusted config still wins: the env vars are read first, so a node that sets
 * `APP_URL` behaves exactly as it did before this existed.
 *
 * Why the Host-header open-redirect objection in this module's header does not
 * apply here: the forwarded headers steer only the ORIGIN, and every caller
 * resolves a relative, same-origin path against it (see `sanitizeReturnTo`),
 * so the result can never point at an attacker's path on their own host — and
 * a browser cannot be made to send `X-Forwarded-Host` cross-site anyway, so
 * the only person a forged value can redirect is whoever forged it. Do not
 * reuse this for a redirect whose TARGET is attacker-influenced.
 */
export function proxyAwarePublicOrigin(request: NextRequest): string {
  return configuredOrigin() ?? forwardedOrigin(request) ?? new URL(request.url).origin;
}
