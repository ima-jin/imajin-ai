/** Names and generation recipes only. Values never belong in a manifest. */
export const APP_SECRET_KINDS = { 'random-32B': 32, 'random-64B': 64 } as const;
export interface AppSecretDeclaration {
  name: string;
  kind: keyof typeof APP_SECRET_KINDS;
}

export function validateSecrets(input: unknown): { ok: AppSecretDeclaration[] } | { error: string } {
  if (input === undefined) return { ok: [] };
  if (!Array.isArray(input) || input.length > 32) return { error: 'secrets must be a list of at most 32 names and kinds' };
  const seen = new Set<string>();
  const declarations: AppSecretDeclaration[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) return { error: 'secrets entries must contain only name and kind' };
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.name !== 'string' || typeof record.kind !== 'string') {
      return { error: 'secrets entries must contain only name and kind' };
    }
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(record.name) || seen.has(record.name)) {
      return { error: 'secret names must be unique uppercase identifiers of at most 64 characters' };
    }
    if (!Object.hasOwn(APP_SECRET_KINDS, record.kind)) return { error: 'secret kind must be random-32B or random-64B' };
    seen.add(record.name);
    declarations.push({ name: record.name, kind: record.kind as AppSecretDeclaration['kind'] });
  }
  return { ok: declarations };
}
