/**
 * Proposal-time read of an app's scope declarations (#2663).
 *
 * `POST /api/apps/provision` calls this BEFORE raising the proposal, so the
 * `providesScopes` / `dependsOn` / `emittableEvents` in `imajin.app.json` are in the card's `detail`
 * (and in the hash the operator signs) when the operator approves — the ruling
 * is that the operator sees and approves that list on the apps.provision card.
 *
 * Public repositories can be read without an installation credential. A missing
 * future app repository may use the template source for the approval snapshot.
 * Unreadable or invalid manifests are errors, never empty approved declarations.
 */
import { appManifestError, fetchAppManifest, tryGetInstallationToken, DEFAULT_APP_TEMPLATE, type AppManifestResult } from '@/src/lib/github/org-provisioning';
import { validateAppDeclarations } from '@/src/lib/kernel/app-declarations';
import { validateEmittableEvents } from '@/src/lib/kernel/emittable-events';
import type { ManifestDeclarations } from './declarations-approval';
import { validateSecrets } from './secret-declarations';


export type ManifestPreviewResult =
  | { ok: ManifestDeclarations }
  | { error: string };

async function readManifest(slug: string, template?: string): Promise<AppManifestResult> {
  try {
    const token = await tryGetInstallationToken();
    const manifest = await fetchAppManifest(slug, token);
    if ('ok' in manifest) return manifest;
    if (manifest.status !== 404 || !template) return manifest;
    const [org, repo] = template.split('/');
    // A fresh repo doesn't exist until approval. Show the source manifest now;
    // registerApp still re-checks the copied manifest against the signed list.
    return await fetchAppManifest(repo, token, org);
  } catch {
    return { error: 'unreadable' };
  }
}

/** Only readable, validated manifests can produce an approval snapshot. */
export async function previewManifestDeclarations(slug: string, template = DEFAULT_APP_TEMPLATE): Promise<ManifestPreviewResult> {
  const result = await readManifest(slug, template);
  if ('error' in result) return { error: appManifestError(slug, result) };
  const manifest = result.ok;
  const secrets = validateSecrets(manifest.secrets);
  if ('error' in secrets) return { error: appManifestError(slug, { error: 'invalid' }) };

  const declarations = await validateAppDeclarations({
    providesScopes: manifest.providesScopes,
    dependsOn: manifest.dependsOn,
    slug,
  });
  if ('error' in declarations) return { error: appManifestError(slug, { error: 'invalid' }) };
  const emittable = validateEmittableEvents(manifest.emittableEvents);
  if ('error' in emittable) return { error: appManifestError(slug, { error: 'invalid' }) };
  return {
    ok: {
      ...(secrets.ok.length > 0 ? { secrets: secrets.ok } : {}),
      providesScopes: declarations.ok.providesScopes,
      dependsOn: declarations.ok.dependsOn,
      emittableEvents: emittable.ok,
    },
  };
}
