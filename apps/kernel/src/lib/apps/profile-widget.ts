import { validateEntryUrl } from './entry-url';

/** Link-only widget: no remote HTML, scripts, frames, or independently chosen origin. */
export interface ProfileWidgetDeclaration {
  path: string;
  label: string;
  icon?: string;
}

type Result = { ok: ProfileWidgetDeclaration | null } | { error: string };

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || !validateEntryUrl(value).ok) return false;
  // Reject encoded separators too; applications must not reinterpret a path as an origin.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return false;
  return validateEntryUrl(new URL(value, 'https://registry.invalid').pathname).ok;
}

export function validateProfileWidget(value: unknown): Result {
  if (value === undefined || value === null) return { ok: null };
  const error = 'profileWidget must contain a root-relative path, label (1-80 characters), and optional icon (1-32 characters) only';
  if (typeof value !== 'object' || Array.isArray(value)) return { error };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['path', 'label', 'icon'].includes(key))) return { error };
  if (!validPath(record.path) || !validText(record.label, 80)) return { error };
  if (record.icon !== undefined && !validText(record.icon, 32)) return { error };
  return { ok: { path: record.path, label: record.label, ...(record.icon === undefined ? {} : { icon: record.icon as string }) } };
}

/** A widget URL is always on the registered entry's origin (or the node for relative entries). */
export function profileWidgetUrl(entryUrl: string | null, declaration: unknown, did: string, handle?: string): string | null {
  const widget = validateProfileWidget(declaration);
  if ('error' in widget || !widget.ok || !entryUrl || !validateEntryUrl(entryUrl).ok) return null;
  const base = new URL(entryUrl, 'https://registry.invalid');
  const target = new URL(widget.ok.path, base);
  if (target.origin !== base.origin) return null;
  target.searchParams.set('did', did);
  if (handle) target.searchParams.set('handle', handle);
  return entryUrl.startsWith('/') ? `${target.pathname}${target.search}${target.hash}` : target.href;
}
