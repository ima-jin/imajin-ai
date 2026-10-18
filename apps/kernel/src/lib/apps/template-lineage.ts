/** Registry metadata, not GitHub credentials or an organization allowlist. */
export interface TemplateLineage {
  sourceRepo?: string | null;
  template?: string | null;
  templateRef?: string | null;
  templateSyncedAt?: Date | null;
  joined?: boolean;
}

/** GitHub owner/name, with no URL, traversal, credentials, or organization restriction. */
export function isRepositoryName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 140 || value.trim() !== value) return false;
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)
    && /^[a-z\d_.-]{1,100}$/i.test(repo)
    && repo !== '.' && repo !== '..';
}

/** Only a complete RFC3339 timestamp is accepted; Date's permissive parser is not validation. */
function syncDate(value: unknown): Date | null | false {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? false : date;
}

function readSyncFields(body: Record<string, unknown>): { ok: TemplateLineage } | { error: string } {
  const ok: TemplateLineage = {};
  if (body.templateRef !== undefined) {
    if (body.templateRef !== null && (typeof body.templateRef !== 'string' || !body.templateRef.trim() || body.templateRef.length > 255)) {
      return { error: 'templateRef must be a non-empty tag/SHA up to 255 characters, or null' };
    }
    ok.templateRef = body.templateRef as string | null;
  }
  if (body.templateSyncedAt !== undefined) {
    const date = syncDate(body.templateSyncedAt);
    if (date === false) return { error: 'templateSyncedAt must be an RFC3339 timestamp or null' };
    ok.templateSyncedAt = date;
  }
  return { ok };
}

/** Omitted fields remain untouched on PATCH; null explicitly clears optional metadata. */
export function validateTemplateLineage(body: Record<string, unknown>): { ok: TemplateLineage } | { error: string } {
  const parsed = readSyncFields(body);
  if ('error' in parsed) return parsed;
  for (const field of ['sourceRepo', 'template'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && !isRepositoryName(value)) return { error: `${field} must be an owner/name repository identifier or null` };
    parsed.ok[field] = value as string | null;
  }
  if (body.joined !== undefined) {
    if (typeof body.joined !== 'boolean') return { error: 'joined must be a boolean' };
    parsed.ok.joined = body.joined;
  }
  return parsed;
}

/** App reports cannot redirect a cascade to another repository or mark themselves joined. */
export function validateTemplateSyncReport(body: Record<string, unknown>): { ok: TemplateLineage } | { error: string } {
  if (Object.keys(body).some((key) => key !== 'templateRef' && key !== 'templateSyncedAt')) {
    return { error: 'A sync report may only set templateRef and templateSyncedAt' };
  }
  if (body.templateRef === undefined || body.templateRef === null || body.templateSyncedAt === undefined || body.templateSyncedAt === null) {
    return { error: 'templateRef and templateSyncedAt are required' };
  }
  return readSyncFields(body);
}
