/**
 * Read current event requests for display, never as the approved emit list.
 * Unlike provisioning previews, this does not check scope/secret declarations
 * or fall back to a template when the registered app's manifest is unavailable.
 */
import {
  fetchAppManifest,
  resolveSourceRepo,
  tryGetInstallationToken,
} from '@/src/lib/github/org-provisioning';
import { validateEmittableEvents } from '@/src/lib/kernel/emittable-events';

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,38}$/;

export type EventDeclarations =
  | { declaredEmittableEvents: string[] }
  | { declaredEmittableEvents: null; eventDeclarationError: string };

/** Call only after authorizing the owner/operator to read this app. */
export async function readEventDeclarations(app: {
  slug: string | null;
  sourceRepo: string | null;
}): Promise<EventDeclarations> {
  const unavailable = (eventDeclarationError: string): EventDeclarations => ({
    declaredEmittableEvents: null,
    eventDeclarationError,
  });
  if (app.sourceRepo === null && (!app.slug || !SLUG_PATTERN.test(app.slug))) {
    return unavailable('No valid registered repository or slug is available to read event declarations');
  }
  try {
    let manifest;
    if (app.sourceRepo !== null) {
      // Keep the existing repository-name/access checks and repository-specific
      // installation credential; never send the default org token elsewhere.
      const source = await resolveSourceRepo(app.sourceRepo);
      const [owner, repo] = app.sourceRepo.split('/');
      manifest = await fetchAppManifest(repo, source.token, owner);
    } else {
      const token = await tryGetInstallationToken();
      manifest = await fetchAppManifest(app.slug!, token);
    }
    if ('error' in manifest) {
      return unavailable(manifest.error === 'invalid'
        ? 'App manifest is invalid; event declarations are unavailable'
        : 'App manifest could not be read; event declarations are unavailable');
    }
    const events = validateEmittableEvents(manifest.ok.emittableEvents);
    if ('error' in events) {
      return unavailable('App manifest event declarations are invalid');
    }
    return { declaredEmittableEvents: events.ok };
  } catch {
    // Do not expose credential/provider errors or declaration values.
    return unavailable('App repository or manifest could not be read; event declarations are unavailable');
  }
}
