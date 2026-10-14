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
import { fetchAppManifest, tryGetInstallationToken, DEFAULT_APP_TEMPLATE, type AppManifest } from '@/src/lib/github/org-provisioning';
import { validateAppDeclarations } from '@/src/lib/kernel/app-declarations';
import { validateEmittableEvents } from '@/src/lib/kernel/emittable-events';
import type { ManifestDeclarations } from './declarations-approval';
import { validateSecrets } from './secret-declarations';

const log = createLogger('kernel:apps:manifest-preview');

export type ManifestPreviewResult =
  | { ok: ManifestDeclarations | null }
  | { error: string };

async function readManifest(slug: string, template?: string): Promise<AppManifest | null> {
  try {
    const token = await tryGetInstallationToken();
    const manifest = await fetchAppManifest(slug, token);
    if (manifest || !template) return manifest;
    const [org, repo] = template.split('/');
    // A fresh repo doesn't exist until approval. Show the source manifest now;
    // registerApp still re-checks the copied manifest against the signed list.
    return await fetchAppManifest(repo, token, org);
  } catch {
    // A malformed credential or a GitHub failure must not block raising the proposal.
    log.warn({ slug }, 'apps.provision: manifest preview unavailable (non-fatal)');
    return null;
  }
}

/** The validated declarations in `slug`'s `imajin.app.json`, `null` when unreadable, or `{ error }` when invalid. */
export async function previewManifestDeclarations(slug: string, template = DEFAULT_APP_TEMPLATE): Promise<ManifestPreviewResult> {
  const manifest = await readManifest(slug, template);
  if (!manifest) return { ok: null };
  const secrets = validateSecrets(manifest.secrets);
  if ('error' in secrets) return { error: secrets.error };

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
      ...(secrets.ok.length > 0 ? { secrets: secrets.ok } : {}),
      providesScopes: declarations.ok.providesScopes,
      dependsOn: declarations.ok.dependsOn,
      emittableEvents: emittable.ok,
    },
  };
}
