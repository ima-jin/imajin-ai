/**
 * Source-type presentation helpers for the corpus dashboard (#1731).
 *
 * A source identifier is `"<sourceType>:<identifier>"` (e.g.
 * `"github:ima-jin/imajin-ai"`, `"local:/home/me/notes"`) — the same
 * convention `ThreadDocument.source` and the corpus adapters use
 * (`apps/corpus/src/adapters/*`). This only derives display icon/label from
 * that prefix; it does not validate or parse the identifier portion.
 */

export const SOURCE_TYPE_OPTIONS = [
  { value: 'github', label: 'GitHub', icon: '🐙', identifierHint: 'owner/repo, e.g. ima-jin/imajin-ai' },
  { value: 'local', label: 'Local Workspace', icon: '💻', identifierHint: 'Absolute path, e.g. /home/me/notes' },
  { value: 'gitlab', label: 'GitLab', icon: '🦊', identifierHint: 'namespace/project' },
  { value: 'discord', label: 'Discord', icon: '💬', identifierHint: 'Server or channel id' },
  { value: 'slack', label: 'Slack', icon: '💬', identifierHint: 'Workspace or channel id' },
  { value: 'gdocs', label: 'Google Docs', icon: '📄', identifierHint: 'Document or folder id' },
] as const;

const ICON_BY_TYPE: Record<string, string> = Object.fromEntries(
  SOURCE_TYPE_OPTIONS.map((opt) => [opt.value, opt.icon]),
);

/** Icon for a full source identifier, e.g. `"github:ima-jin/imajin-ai"` → 🐙. */
export function iconForSource(source: string): string {
  const sourceType = source.split(':')[0];
  return ICON_BY_TYPE[sourceType] ?? '📦';
}

/** Builds the full `"<sourceType>:<identifier>"` source string sent to the API. */
export function composeSource(sourceType: string, identifier: string): string {
  return `${sourceType}:${identifier.trim()}`;
}
