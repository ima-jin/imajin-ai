/**
 * Proposal-time read of an app's scope declarations (#2663).
 *
 * `POST /api/apps/provision` calls this BEFORE raising the proposal, so the
 * `providesScopes` / `dependsOn` / `emittableEvents` in `imajin.app.json` are in the card's `detail`
 * (and in the hash the operator signs) when the operator approves — the ruling
 * is that the operator sees and approves that list on the apps.provision card.
 *
 * Best effort, like the provision-time manifest read: an unsealed org credential,
 * a repo that doesn't exist yet, or a missing/invalid manifest all yield `null`
 * ("nothing was read") rather than an error. What the card then shows, and what
 * provisioning then registers, is nothing — `registerApp` refuses a manifest that
 * declares anything the operator didn't see.
 *
 * A manifest that IS readable but declares something invalid (a vocabulary scope
 * as `providesScopes`, an unregistered `dependsOn` audience, ...) is an error here,
 * so the operator is never asked to approve a list that would be refused anyway.
 */
import { createLogger } from '@imajin/logger';
import { fetchAppManifest, tryGetInstallationToken, type AppManifest } from '@/src/lib/github/org-provisioning';
import { validateAppDeclarations } from '@/src/lib/kernel/app-declarations';
import { validateEmittableEvents } from '@/src/lib/kernel/emittable-events';
import type { ManifestDeclarations } from './declarations-approval';

const log = createLogger('kernel:apps:manifest-preview');

export type ManifestPreviewResult =
  | { ok: ManifestDeclarations | null }
  | { error: string };

async function readManifest(slug: string): Promise<AppManifest | null> {
  try {
    const token = await tryGetInstallationToken();
    return await fetchAppManifest(slug, token);
  } catch (err) {
    // A malformed credential or a GitHub failure must not block raising the proposal.
    log.warn({ err: String(err), slug }, 'apps.provision: manifest preview unavailable (non-fatal)');
    return null;
  }
}

/** The validated declarations in `slug`'s `imajin.app.json`, `null` when unreadable, or `{ error }` when invalid. */
export async function previewManifestDeclarations(slug: string): Promise<ManifestPreviewResult> {
  const manifest = await readManifest(slug);
  if (!manifest) return { ok: null };

  const declarations = await validateAppDeclarations({
    providesScopes: manifest.providesScopes,
    dependsOn: manifest.dependsOn,
    slug,
  });
  if ('error' in declarations) return { error: declarations.error };
  const emittable = validateEmittableEvents(manifest.emittableEvents);
  if ('error' in emittable) return { error: emittable.error };
  return {
    ok: {
      providesScopes: declarations.ok.providesScopes,
      dependsOn: declarations.ok.dependsOn,
      emittableEvents: emittable.ok,
    },
  };
}
