/**
 * Pure validation for the operator-approved list of event types a registered app
 * may emit (#2638 / #2641) — `registry.apps.emittable_events`. No DB, no network:
 * shared by the register/admin routes, the apps.provision pipeline and the card.
 * The DB lookup lives in `app-emittable-events.ts`.
 *
 * Same ceiling pattern as approved scopes: the app (or its manifest) *declares*,
 * an operator *approves* on an operator-only path, and nothing beyond the
 * approved list is ever honoured. Default for every app: nothing.
 */
/** Dotted lowercase event-type name, e.g. `tip.granted`, `warp.run.still_running`. No wildcards. */
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
export const MAX_EVENT_TYPE_LENGTH = 100;
export const MAX_EMITTABLE_EVENTS = 50;

/**
 * Event namespaces (the first dotted segment) the kernel owns (#2717). An app can
 * neither be approved for, nor emit, a type in one of them: an app-sent
 * `payment_request.paid` or `loop.completed` would put a kernel-voiced line into the
 * audit trail and notify people as if the kernel had said it. The set is the
 * identity / auth / money / ledger / vault / registry surface; namespaces that name an
 * app's own domain (`tip`, `listing`, `ticket`, ...) are deliberately NOT here, because
 * those are what standalone apps legitimately emit (#2638 market, #2641 coffee).
 * What an accepted event can trigger is bounded separately (notify + audit-log only).
 */
export const KERNEL_EVENT_NAMESPACES: ReadonlySet<string> = new Set([
  'access', 'agent', 'app', 'apps', 'approval', 'asset', 'attestation', 'audit', 'auth', 'broker', 'bus',
  'connection', 'connector', 'consent', 'fee', 'group', 'handle', 'identity', 'kernel', 'loop', 'mjn',
  'notify', 'operator', 'order', 'pay', 'payment', 'payment_request', 'pod', 'profile', 'registry',
  'scope', 'session', 'settle', 'settlement', 'stripe', 'stub', 'supply', 'telemetry', 'transaction',
  'usage', 'vault', 'vouch',
]);

/** Cap on `payload.interestDids` — the notify reactor sends one interest signal per entry (#2717). */
export const MAX_INTEREST_DIDS = 25;
export const MAX_INTEREST_DID_LENGTH = 256;

/**
 * Audiences a token must be minted for before `POST /api/events` accepts it (#2717).
 * `imajin:apps` is what the keyholder app-service token carries today
 * (`createAppServiceToken`'s default); `jin` is the kernel's own seeded registry
 * audience (#2706 — registry audiences are slugs, never hosts). A token minted for
 * any other audience — another app's slug, a dependency audience — is not this
 * endpoint's token.
 */
export const EVENTS_API_AUDIENCES: readonly string[] = ['imajin:apps', 'jin'];

/** True when a verified token's `aud` claim (string or array) names an audience this endpoint serves. */
export function hasEventsApiAudience(aud: unknown): boolean {
  const auds = Array.isArray(aud) ? aud : [aud];
  return auds.some((a) => typeof a === 'string' && EVENTS_API_AUDIENCES.includes(a));
}

/** True when `type` sits in a kernel-owned namespace — never approvable, never emittable by an app. */
export function isKernelEventType(type: string): boolean {
  return KERNEL_EVENT_NAMESPACES.has(type.split('.')[0]);
}

/**
 * The 400 body self-service register/PATCH return for an `emittableEvents`
 * field. Letting an app choose what it may emit would make the allowlist
 * meaningless, so it is written only by an operator path: the admin registry
 * route, or `apps.provision` (where the operator approves the list on the /jin
 * card before anything is registered).
 */
export const EMITTABLE_EVENTS_OPERATOR_ONLY_ERROR =
  'emittableEvents can only be set by a node operator (admin registry route or apps.provision); it is not accepted on self-service registration';

export function isValidEventType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EVENT_TYPE_LENGTH && EVENT_TYPE_PATTERN.test(value);
}

export type EmittableEventsResult = { ok: string[] } | { error: string };

/**
 * Validate and normalise an `emittableEvents` list: an array of well-formed,
 * wildcard-free event-type strings, de-duplicated and sorted so two lists that
 * grant the same things are byte-identical. `undefined` means "none declared".
 */
export function validateEmittableEvents(input: unknown): EmittableEventsResult {
  if (input === undefined || input === null) return { ok: [] };
  if (!Array.isArray(input)) return { error: 'emittableEvents must be an array of event-type strings' };

  const invalid = input.filter((v) => !isValidEventType(v)).map((v) => JSON.stringify(v) ?? String(v));
  if (invalid.length > 0) {
    return { error: `emittableEvents entries must be lowercase dotted event types (no wildcards): ${invalid.join(', ')}` };
  }
  const reserved = input.filter((v: string) => isKernelEventType(v));
  if (reserved.length > 0) {
    return { error: `emittableEvents cannot include kernel-owned event types: ${reserved.join(', ')}` };
  }
  const unique = [...new Set(input as string[])].sort((a, b) => a.localeCompare(b));
  if (unique.length > MAX_EMITTABLE_EVENTS) {
    return { error: `emittableEvents may list at most ${MAX_EMITTABLE_EVENTS} event types` };
  }
  return { ok: unique };
}

/** Read an approved list back out of a DB value; anything malformed approves nothing. */
export function readEmittableEvents(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isValidEventType) : [];
}
