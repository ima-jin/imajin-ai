/**
 * The scope declarations an operator approves on the `apps.provision` card (#2663).
 *
 * At proposal time the kernel reads `providesScopes` / `dependsOn` from the app's
 * `imajin.app.json` and snapshots them into the proposal's `detail`
 * (`manifestDeclarations`), which is hashed into the card the operator signs. At
 * approval time `registerApp` registers ONLY what matches that snapshot — so what
 * the operator saw on the card is exactly what gets granted.
 *
 * Pure (no DB, no network): shared by the proposal route, the approvals bridge,
 * the provisioning pipeline, and the card.
 */
import type { AppDependency } from '@imajin/auth';

export interface ManifestDeclarations {
  providesScopes: string[];
  dependsOn: AppDependency[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isDependency(value: unknown): value is AppDependency {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.aud === 'string' && isStringArray(v.scopes);
}

/**
 * Read an approved-declarations snapshot out of an untrusted proposal `detail`
 * value. Returns `null` for anything that isn't exactly the expected shape —
 * including an absent value, which means "no manifest was readable at proposal
 * time" and approves nothing.
 */
export function parseManifestDeclarations(value: unknown): ManifestDeclarations | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isStringArray(v.providesScopes)) return null;
  if (!Array.isArray(v.dependsOn) || !v.dependsOn.every(isDependency)) return null;
  return {
    providesScopes: [...v.providesScopes],
    dependsOn: v.dependsOn.map((d) => ({ aud: d.aud, scopes: [...d.scopes] })),
  };
}

/** Order-insensitive canonical form, so two lists compare equal iff they grant the same things. */
function canonical(declarations: ManifestDeclarations): string {
  return JSON.stringify({
    providesScopes: [...new Set(declarations.providesScopes)].sort((a, b) => a.localeCompare(b)),
    dependsOn: declarations.dependsOn
      .map((d) => ({ aud: d.aud, scopes: [...new Set(d.scopes)].sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => a.aud.localeCompare(b.aud)),
  });
}

/** True iff `actual` grants exactly what `approved` does — nothing more, nothing less. */
export function sameDeclarations(actual: ManifestDeclarations, approved: ManifestDeclarations): boolean {
  return canonical(actual) === canonical(approved);
}

/** The empty list: what a proposal with no readable manifest approves. */
export const NO_DECLARATIONS: ManifestDeclarations = { providesScopes: [], dependsOn: [] };
