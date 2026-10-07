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
