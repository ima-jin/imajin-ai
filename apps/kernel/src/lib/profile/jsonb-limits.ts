/**
 * Shared size guard for user-writable `profile.profiles` jsonb columns (#2432).
 *
 * The profile routes accept owner-supplied jsonb that is later served
 * publicly (tax registrations even print on invoices), so every such field is
 * capped on three axes by ONE validator rather than per-field patches:
 *
 *  - maxEntries:      array length, or number of top-level keys for an object
 *  - maxStringLength: longest individual string anywhere in the value, measured
 *                     in UTF-16 code units (`String#length`) — covers e.g. a
 *                     tax registration `label`, at any nesting depth
 *  - maxBytes:        UTF-8 byte length of the serialized JSON (`JSON.stringify`)
 *
 * A violation yields a 400 whose error names the field. These limits are the
 * source of truth; the schema (`src/db/schemas/profile.ts`) points here.
 * Limits are deliberately generous relative to real usage — they bound abuse,
 * not normal profiles. No DB constraint backs them (no migration): the routes
 * are the only writers.
 */

export interface JsonbLimits {
  maxEntries: number;
  maxStringLength: number;
  maxBytes: number;
}

/** Profile jsonb columns guarded by {@link validateJsonbSize}, keyed by API field name. */
export const PROFILE_JSONB_LIMITS = {
  /** `profiles.tax_registrations` — a business rarely holds more than a handful. */
  taxRegistrations: { maxEntries: 50, maxStringLength: 200, maxBytes: 16 * 1024 },
  /** `profiles.metadata` — free-form location/website/etc. Entries = top-level keys. */
  metadata: { maxEntries: 100, maxStringLength: 2000, maxBytes: 32 * 1024 },
  /** `profiles.agent_pricing` — pricing manifest. Entries = top-level keys. */
  agentPricing: { maxEntries: 50, maxStringLength: 1000, maxBytes: 16 * 1024 },
  /** `profiles.feature_toggles` — checked on the merged result, not just the patch. */
  featureToggles: { maxEntries: 100, maxStringLength: 200, maxBytes: 8 * 1024 },
  /** `profiles.field_visibility` — one rule per metadata key. */
  fieldVisibility: { maxEntries: 100, maxStringLength: 500, maxBytes: 32 * 1024 },
} as const satisfies Record<string, JsonbLimits>;

export type ProfileJsonbField = keyof typeof PROFILE_JSONB_LIMITS;

export interface JsonbSizeResult {
  valid: boolean;
  /** API field name the error refers to. */
  field: string;
  /** Human-readable, field-named message when `valid` is false. */
  error?: string;
}

function entryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length;
  return 0;
}

/**
 * Length of the longest string in `value` (object keys included), walked
 * iteratively so a deeply nested payload cannot overflow the call stack.
 */
function longestString(value: unknown): number {
  let longest = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      longest = Math.max(longest, current.length);
    } else if (typeof current === 'object' && current !== null) {
      if (!Array.isArray(current)) {
        for (const key of Object.keys(current)) longest = Math.max(longest, key.length);
      }
      for (const child of Object.values(current)) stack.push(child);
    }
  }
  return longest;
}

function serializedBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).length;
  } catch {
    return null;
  }
}

/**
 * Check `value` against the caps for `field`. `null`/`undefined` always pass
 * (clearing a field is fine). Type/shape validation stays with each field's own
 * validator — this only bounds size.
 */
export function validateJsonbSize(field: ProfileJsonbField, value: unknown): JsonbSizeResult {
  if (value === undefined || value === null) return { valid: true, field };
  const limits: JsonbLimits = PROFILE_JSONB_LIMITS[field];

  const entries = entryCount(value);
  if (entries > limits.maxEntries) {
    return { valid: false, field, error: `${field} has too many entries (${entries}; max ${limits.maxEntries})` };
  }
  const longest = longestString(value);
  if (longest > limits.maxStringLength) {
    return { valid: false, field, error: `${field} contains a string that is too long (${longest} characters; max ${limits.maxStringLength})` };
  }
  const bytes = serializedBytes(value);
  if (bytes === null) {
    return { valid: false, field, error: `${field} is not serializable as JSON` };
  }
  if (bytes > limits.maxBytes) {
    return { valid: false, field, error: `${field} is too large (${bytes} bytes; max ${limits.maxBytes})` };
  }
  return { valid: true, field };
}
