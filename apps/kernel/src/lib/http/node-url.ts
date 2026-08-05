import { toOrigin } from "./public-origin";

/**
 * This node's public origin, for machine-readable discovery documents.
 *
 * Used by the A2A agent card, `.well-known/fair-policy.json`,
 * `.well-known/security.txt`, and the DID Document `chainEndpoint` builders —
 * every URL a stranger's agent or a cold verifier is told to follow.
 *
 * Those callers previously hand-rolled `${NEXT_PUBLIC_SERVICE_PREFIX}${NEXT_PUBLIC_DOMAIN}`,
 * which silently assumes the prefix is a bare scheme. That was true under the old
 * multi-subdomain layout, but in single-domain mode the prefix is a full origin
 * WITH a trailing slash (`https://jin.imajin.ai/`), so the concatenation produced
 * `https://jin.imajin.ai/imajin.ai` — a doubled path segment that 404s every
 * advertised endpoint (#1614).
 *
 * Resolution order:
 *   1. An explicit public origin — `APP_URL`, then `NEXT_PUBLIC_BASE_URL`. Same
 *      source of truth as browser-facing redirects (#1608), so one env var
 *      governs both. `APP_URL` is not `NEXT_PUBLIC_`-prefixed, so it is read at
 *      runtime rather than inlined at build time; callers must therefore be
 *      dynamically rendered or they will bake whatever the build env had.
 *   2. The service-prefix convention, handling BOTH historical shapes.
 *
 * Note `buildPublicUrlAbsolute('kernel')` from `@imajin/config` is deliberately
 * NOT used: it resolves the single-domain shape correctly but falls through to
 * subdomain construction for a scheme-only prefix, yielding
 * `https://kernel.imajin.ai` instead of the apex.
 */

/**
 * Derive the origin from `NEXT_PUBLIC_SERVICE_PREFIX` + `NEXT_PUBLIC_DOMAIN`.
 *
 * Single-domain shape: the prefix already carries the host
 * (`https://jin.imajin.ai/`) — use it and ignore the domain, which would
 * otherwise be appended as a path segment.
 *
 * Legacy shape: the prefix is a bare scheme (`https://`) and the node lives at
 * the apex of `NEXT_PUBLIC_DOMAIN`.
 */
function originFromServicePrefix(): string {
  const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX ?? "https://";
  const domain = process.env.NEXT_PUBLIC_DOMAIN ?? "imajin.ai";

  const scheme = prefix.startsWith("http://") ? "http" : "https";
  const prefixHost = prefix.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  // A dot means the prefix carries a real host; `http://localhost:` and a bare
  // `https://` do not, so fall back to the configured domain.
  const host = prefixHost.includes(".") ? prefixHost : domain;

  return `${scheme}://${host}`;
}

/** The origin to advertise in discovery documents. Never has a trailing slash. */
export function nodeUrl(): string {
  return (
    toOrigin(process.env.APP_URL) ??
    toOrigin(process.env.NEXT_PUBLIC_BASE_URL) ??
    originFromServicePrefix()
  );
}
