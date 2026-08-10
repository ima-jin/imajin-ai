/**
 * Platform/org DID for shared, platform-owned connector credentials (#1775).
 *
 * Some connectors use a two-tier credential model instead of BYO-app:
 *   Tier 1 (platform) — the provider's OAuth app (e.g. Intuit client_id +
 *     client_secret) is registered once by an administrator and shared by
 *     every connecting user.
 *   Tier 2 (per-user) — each user's own resulting tokens, sealed to their own
 *     DID.
 *
 * `PLATFORM_DID` already exists for exactly this purpose — the pay settlement
 * flow uses it as the issuer identity for platform-level attestations (see
 * `app/pay/api/settle/route.ts`). Reusing it here means one platform identity
 * per node, not a new env var per connector that needs the same shape.
 */

/**
 * The env-configured platform DID, or undefined when unset/blank.
 *
 * Trimmed and blank-checked once here so every caller gets the same
 * "unconfigured" reading instead of each re-deriving it from the raw env var.
 */
export function getPlatformDid(): string | undefined {
  const trimmed = process.env.PLATFORM_DID?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
