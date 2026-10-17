import { validateEntryUrl } from './entry-url';
import { validateProfileWidget } from './profile-widget';

const PLACEMENTS = ['launcher', 'home', 'auth-submenu'];
const SCOPES = ['actor', 'business', 'community', 'family'];

/** Validated operator presentation fields; never installs or authorizes an app. */
export function validateRegistryPresentation(body: Record<string, unknown>) {
  const widget = validateProfileWidget(body.profileWidget);
  if ('error' in widget) return widget;
  const entryUrl = body.entryUrl ?? null;
  if (entryUrl !== null && (typeof entryUrl !== 'string' || !validateEntryUrl(entryUrl).ok)) {
    return { error: 'entryUrl must be a root-relative path or HTTPS URL' } as const;
  }
  if (widget.ok && !entryUrl) return { error: 'profileWidget requires entryUrl' } as const;
  const placements = body.placements ?? [];
  if (!Array.isArray(placements) || !placements.every((value) => PLACEMENTS.includes(value))) {
    return { error: 'placements must contain supported nav placements only' } as const;
  }
  const requiredScope = body.requiredScope ?? null;
  if (requiredScope !== null && !SCOPES.includes(requiredScope as string)) return { error: 'Invalid requiredScope' } as const;
  const icon = body.icon ?? null;
  if (icon !== null && (typeof icon !== 'string' || icon.length > 32)) return { error: 'Invalid icon' } as const;
  return { ok: { entryUrl: entryUrl as string | null, profileWidget: widget.ok, placements: placements as string[], requiredScope: requiredScope as string | null, icon: icon as string | null } };
}
