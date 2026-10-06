/**
 * App-declared scopes and the app dependency list (#2663).
 *
 * `SCOPE_VOCABULARY` (./scope-vocabulary.ts) is the platform's scope table. A
 * registered app can't edit it, so scopes the app itself enforces (dykil's
 * `dykil:read` / `dykil:write`) used to be dropped by `validateScopes()` at
 * token mint. This module is the extension point: a registry app declares
 *
 *   providesScopes — scope strings the app defines and enforces itself
 *   dependsOn      — other registered audiences (and the vocabulary scopes it
 *                    needs there) a token minted for the app must also satisfy
 *
 * Both ride the same `registry.apps` row that already carries
 * `requestedScopes`, the existing app scope-assignment model. They add to the
 * platform vocabulary and never replace it: an app cannot declare a scope the
 * vocabulary already owns, or one in a namespace the vocabulary owns.
 *
 * Pure and dependency-free apart from the vocabulary, so the kernel routes
 * and their tests share one implementation.
 */
import { SCOPE_VOCABULARY, isKnownScope } from './scope-vocabulary';

/** `namespace:verb[:more]`, lowercase, no whitespace. */
const APP_SCOPE_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;

/** A bare host with an optional port — the shape every `aud` already takes. */
const AUDIENCE_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

/** Namespaces (`media`, `wallet`, …) the platform vocabulary owns; apps may not claim them. */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set(
  SCOPE_VOCABULARY.map((entry) => entry.scope.split(':')[0]),
);

/** One entry of an app's `dependsOn` list. */
export interface AppDependency {
  /** Audience (host) of the registered service the app depends on. */
  aud: string;
  /** Vocabulary scopes the app needs on that service. */
  scopes: string[];
}

function namespaceOf(scope: string): string {
  return scope.split(':')[0];
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * Validate the scopes an app wants to declare as its own.
 *
 * A scope is rejected when it is not a string, is malformed, is already in the
 * platform vocabulary, or sits in a namespace the vocabulary owns. When the app
 * has a `slug`, every scope must also be in that namespace (`dykil:*` for
 * `dykil`), so one app can't squat another's namespace.
 */
export function validateProvidedScopes(
  scopes: unknown,
  options: { slug?: string | null } = {},
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const list: unknown[] = Array.isArray(scopes) ? scopes : [];
  for (const s of list) {
    if (typeof s !== 'string' || !APP_SCOPE_PATTERN.test(s) || isKnownScope(s)) {
      invalid.push(String(s));
      continue;
    }
    const ns = namespaceOf(s);
    if (RESERVED_NAMESPACES.has(ns) || (options.slug && ns !== options.slug)) {
      invalid.push(s);
      continue;
    }
    valid.push(s);
  }
  return { valid: dedupe(valid), invalid: dedupe(invalid) };
}

/**
 * Clamp requested scopes to the platform vocabulary plus the app's own
 * `providesScopes`. Same contract as `validateScopes()`, widened by the app's
 * declared scopes — and only those: they are never added to another app's token.
 */
export function resolveAppScopes(
  requested: readonly string[],
  providesScopes: readonly string[] = [],
): { valid: string[]; invalid: string[] } {
  const own = new Set(providesScopes);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const s of requested) {
    if (typeof s === 'string' && (isKnownScope(s) || own.has(s))) valid.push(s);
    else invalid.push(String(s));
  }
  return { valid: dedupe(valid), invalid: dedupe(invalid) };
}

/**
 * Validate a `dependsOn` list. Each entry needs a well-formed `aud` and a
 * non-empty list of platform-vocabulary scopes. Duplicate audiences merge.
 * Whether the audience is a *registered* app is the caller's job: it needs the DB.
 */
export function validateDependsOn(input: unknown): { valid: AppDependency[]; invalid: string[] } {
  const byAud = new Map<string, Set<string>>();
  const invalid: string[] = [];
  const list: unknown[] = Array.isArray(input) ? input : [];
  for (const item of list) {
    const entry = (item && typeof item === 'object' ? item : {}) as { aud?: unknown; scopes?: unknown };
    const aud = typeof entry.aud === 'string' ? entry.aud.trim().toLowerCase() : '';
    const scopes = Array.isArray(entry.scopes) ? entry.scopes : [];
    if (!aud || !AUDIENCE_PATTERN.test(aud) || scopes.length === 0) {
      invalid.push(aud || String(item));
      continue;
    }
    if (!scopes.every((s) => typeof s === 'string' && isKnownScope(s))) {
      invalid.push(aud);
      continue;
    }
    const merged = byAud.get(aud) ?? new Set<string>();
    for (const s of scopes as string[]) merged.add(s);
    byAud.set(aud, merged);
  }
  return {
    valid: [...byAud].map(([aud, scopes]) => ({ aud, scopes: [...scopes] })),
    invalid: dedupe(invalid),
  };
}

/**
 * Audiences a token minted for `aud` carries: `aud` first, then the audiences
 * from the app's `dependsOn` that the caller confirmed are still registered and
 * active. The primary audience stays first so single-audience readers
 * (`payload.aud[0]`) keep seeing the app's own host.
 */
export function tokenAudiences(aud: string, activeDependencyAuds: readonly string[]): string[] {
  return dedupe([aud, ...activeDependencyAuds]);
}
