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

/** True iff `slug` is set and `scope` is in the `<slug>:` namespace. */
function inSlugNamespace(scope: string, slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.length > 0 && namespaceOf(scope) === slug;
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/**
 * Validate the scopes an app wants to declare as its own (#2674).
 *
 * Namespaces are reserved by registered slug: an app may only declare scopes in
 * the namespace of its own `slug` (`dykil:*` for `dykil`). An app with no slug
 * owns no namespace, so it can't declare any app-namespaced scope — without that,
 * a slug-less self-service app could declare `dykil:read` and squat another app's
 * namespace. (Every valid app scope is namespaced, so a slug-less app declares none.)
 *
 * A scope is also rejected when it is not a string, is malformed, is already in the
 * platform vocabulary, or sits in a namespace the vocabulary owns.
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
    if (RESERVED_NAMESPACES.has(namespaceOf(s)) || !inSlugNamespace(s, options.slug)) {
      invalid.push(s);
      continue;
    }
    valid.push(s);
  }
  return { valid: dedupe(valid), invalid: dedupe(invalid) };
}

/**
 * The subset of an app's stored `providesScopes` that sit in its own slug
 * namespace. Write-side validation already enforces this; applying it again when
 * a row is read closes the same gap for rows written before it did, so a legacy
 * slug-less row can't keep honouring `dykil:read` at mint.
 */
export function ownNamespaceScopes(providesScopes: readonly string[], slug: string | null | undefined): string[] {
  return providesScopes.filter((s) => inSlugNamespace(s, slug));
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

/** What an app's registry row says it may be granted (the existing scope-assignment fields). */
export interface ScopeAssignment {
  /** `registry.apps.requested_scopes` — the scope-assignment record the approved list is written into. */
  requestedScopes?: readonly string[] | null;
  providesScopes?: readonly string[] | null;
  dependsOn?: readonly AppDependency[] | null;
  tier?: string | null;
}

/**
 * The most an app may ever be granted (#2674): its assigned `requestedScopes`, the
 * scopes it declared it provides, and the scopes of the dependencies an operator
 * approved. `providesScopes` and `dependsOn` are only ever written by an approved
 * path (`apps.provision` or the admin route; PATCH is capped by this same ceiling),
 * so the ceiling can't be raised after approval.
 */
export function approvedScopeCeiling(app: ScopeAssignment): Set<string> {
  return new Set([
    ...(app.requestedScopes ?? []),
    ...(app.providesScopes ?? []),
    ...(app.dependsOn ?? []).flatMap((dep) => dep.scopes),
  ]);
}

/**
 * Clamp `scopes` to the app's {@link approvedScopeCeiling}. The one exemption is a
 * legacy `first_party` row with nothing assigned (`requested_scopes = []`, as seeded
 * by 0139): those predate scope assignment and are operator-registered, so an empty
 * list there means "never assigned", not "nothing allowed". Every other tier —
 * including a third-party app with an empty list — gets exactly its ceiling.
 */
export function clampToApprovedCeiling(scopes: readonly string[], app: ScopeAssignment): string[] {
  const ceiling = approvedScopeCeiling(app);
  if (app.tier === 'first_party' && ceiling.size === 0) return [...scopes];
  return scopes.filter((s) => ceiling.has(s));
}

/**
 * The scopes of a multi-audience token that are honoured at `aud` (#2674).
 *
 * Scopes ride on the token as one flat list, so without this a token carrying two
 * dependency audiences would honour dependency A's scopes at dependency B. The
 * token's primary audience (the app itself) honours everything on the token; each
 * dependency honours only the scopes listed for it in the app's `dependsOn`. A
 * dependency the app no longer lists honours none.
 */
export function scopesForAudience(
  aud: string,
  primaryAud: string,
  tokenScopes: readonly string[],
  dependsOn: readonly AppDependency[],
): string[] {
  if (aud === primaryAud) return [...tokenScopes];
  const listed = new Set(dependsOn.filter((dep) => dep.aud === aud).flatMap((dep) => dep.scopes));
  return tokenScopes.filter((s) => listed.has(s));
}
