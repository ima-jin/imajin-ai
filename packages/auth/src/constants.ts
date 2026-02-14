/**
 * TTL Constants for Imajin Auth System
 * 
 * Centralized time-to-live values for all auth-related expiries.
 * All values in milliseconds unless noted.
 */

// =============================================================================
// TIME HELPERS
// =============================================================================

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// =============================================================================
// AUTH FLOW TTLs
// =============================================================================

/**
 * Challenge TTL: 5 minutes
 * Short-lived challenge for authentication flow.
 * User must sign and return within this window.
 */
export const CHALLENGE_TTL = 5 * MINUTE;

/**
 * Bearer Token TTL: 24 hours
 * Standard session token for API access.
 * Requires re-authentication after expiry.
 */
export const TOKEN_TTL = 24 * HOUR;

/**
 * Signed Message Max Age: 5 minutes (default)
 * For real-time verification of signed messages.
 * Can be overridden per-verification.
 */
export const SIGNED_MESSAGE_MAX_AGE = 5 * MINUTE;

/**
 * Future timestamp tolerance: 30 seconds
 * Allow messages slightly in the future (clock skew).
 */
export const FUTURE_TOLERANCE = 30 * SECOND;

// =============================================================================
// NODE REGISTRATION TTLs
// =============================================================================

/**
 * Node Registration TTL: 30 days
 * How long a node's subdomain registration remains valid.
 * Must renew before expiry to maintain subdomain.
 */
export const NODE_REGISTRATION_TTL = 30 * DAY;

/**
 * Node Heartbeat Interval: 24 hours
 * How often nodes should ping the registry to prove liveness.
 */
export const NODE_HEARTBEAT_INTERVAL = 24 * HOUR;

/**
 * Node Stale Threshold: 3 days
 * After 3 missed heartbeats, node marked as "stale".
 * Still functional, but flagged for potential issues.
 */
export const NODE_STALE_THRESHOLD = 3 * DAY;

/**
 * Node Unreachable Threshold: 7 days
 * After 7 missed heartbeats, node marked as "unreachable".
 * May lose subdomain priority if contested.
 */
export const NODE_UNREACHABLE_THRESHOLD = 7 * DAY;

/**
 * Node Grace Period: 7 days
 * After registration expires, subdomain reserved but inactive.
 * Allows recovery without losing hostname to others.
 */
export const NODE_GRACE_PERIOD = 7 * DAY;

/**
 * Build Attestation Refresh: At registration renewal
 * Build hash must be re-verified:
 * - On any version change (immediate)
 * - At 30-day registration renewal (routine)
 */
export const BUILD_ATTESTATION_REFRESH = NODE_REGISTRATION_TTL;

// =============================================================================
// RATE LIMITS
// =============================================================================

/**
 * Challenge Rate Limit: 10 per hour per identity
 * Prevents challenge spam attacks.
 */
export const CHALLENGE_RATE_LIMIT = 10;
export const CHALLENGE_RATE_WINDOW = HOUR;

/**
 * Registration Rate Limit: 5 per day per IP
 * Prevents subdomain squatting attacks.
 */
export const REGISTRATION_RATE_LIMIT = 5;
export const REGISTRATION_RATE_WINDOW = DAY;

// =============================================================================
// EXPORT SUMMARY
// =============================================================================

export const TTL = {
  // Auth flow
  challenge: CHALLENGE_TTL,
  token: TOKEN_TTL,
  signedMessage: SIGNED_MESSAGE_MAX_AGE,
  futureTolerance: FUTURE_TOLERANCE,
  
  // Node lifecycle
  nodeRegistration: NODE_REGISTRATION_TTL,
  nodeHeartbeat: NODE_HEARTBEAT_INTERVAL,
  nodeStale: NODE_STALE_THRESHOLD,
  nodeUnreachable: NODE_UNREACHABLE_THRESHOLD,
  nodeGrace: NODE_GRACE_PERIOD,
  buildAttestation: BUILD_ATTESTATION_REFRESH,
  
  // Rate limits
  challengeRateLimit: CHALLENGE_RATE_LIMIT,
  challengeRateWindow: CHALLENGE_RATE_WINDOW,
  registrationRateLimit: REGISTRATION_RATE_LIMIT,
  registrationRateWindow: REGISTRATION_RATE_WINDOW,
} as const;
