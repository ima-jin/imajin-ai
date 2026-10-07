/**
 * Write-side validation for what a registered app declares about itself (#2663):
 * `providesScopes` (scopes it defines and enforces) and `dependsOn` (other
 * registered audiences a token for it must also carry).
 *
 * Shared by every route that writes a `registry.apps` row — self-service
 * register/PATCH and the admin surface — so the rules live in one place. Mint-time
 * enforcement is in `app-registry.ts` (`resolveTokenAudiences`) and
 * `POST /auth/api/tokens/app`.
 */
import {
  resolveAppScopes,
  validateDependsOn,
  validateProvidedScopes,
  type AppDependency,
} from '@imajin/auth';
import { resolveActiveAppByAudience } from '@/src/lib/kernel/app-registry';

/**
 * The 400 body self-service register/PATCH return for a `dependsOn` field.
 * `dependsOn` hands an app's tokens another service's audience, so it is written
 * only by an operator path: the admin registry route, or `apps.provision` (where
 * the operator approves the list on the /jin card before anything is registered).
 */
export const DEPENDS_ON_OPERATOR_ONLY_ERROR =
  'dependsOn can only be set by a node operator (admin registry route or apps.provision); it is not accepted on self-service registration';

export interface AppDeclarationsInput {
  providesScopes?: unknown;
  dependsOn?: unknown;
  /** When present, clamped to the platform vocabulary + the declared `providesScopes`. */
  requestedScopes?: unknown;
  /**
   * The app's registered slug. `providesScopes` must live in that namespace (#2674), so an
   * app without a slug can't declare any: namespaces are reserved by slug.
   */
  slug?: string | null;
}

export interface AppDeclarations {
  providesScopes: string[];
  dependsOn: AppDependency[];
  requestedScopes: string[];
}

export type AppDeclarationsResult = { ok: AppDeclarations } | { error: string };

/**
 * Validate and normalise an app's declarations. Returns `{ error }` (for a 400)
 * when any `providesScopes` entry is rejected or any `dependsOn` entry is
 * malformed or names an audience that isn't a registered, active app.
 *
 * `requestedScopes` never errors — an unknown scope is dropped, as it always has
 * been — but the app's own `providesScopes` now survive that clamp.
 */
export async function validateAppDeclarations(input: AppDeclarationsInput): Promise<AppDeclarationsResult> {
  const provided = validateProvidedScopes(input.providesScopes ?? [], { slug: input.slug });
  if (provided.invalid.length > 0) {
    const slugHint = input.slug ? '' : ' — an app without a registered slug owns no scope namespace and cannot declare any';
    return { error: `providesScopes rejected (malformed, already in the platform vocabulary, or in a reserved or foreign namespace): ${provided.invalid.join(', ')}${slugHint}` };
  }

  const deps = validateDependsOn(input.dependsOn ?? []);
  if (deps.invalid.length > 0) {
    return { error: `dependsOn entries must be { aud, scopes[] } with platform-vocabulary scopes: ${deps.invalid.join(', ')}` };
  }
  const registered = await Promise.all(deps.valid.map((dep) => resolveActiveAppByAudience(dep.aud)));
  const unregistered = deps.valid.filter((_dep, i) => !registered[i]).map((dep) => dep.aud);
  if (unregistered.length > 0) {
    return { error: `dependsOn audiences are not registered apps: ${unregistered.join(', ')}` };
  }

  const requested = Array.isArray(input.requestedScopes) ? input.requestedScopes : [];
  const { valid: requestedScopes } = resolveAppScopes(requested, provided.valid);

  return { ok: { providesScopes: provided.valid, dependsOn: deps.valid, requestedScopes } };
}
