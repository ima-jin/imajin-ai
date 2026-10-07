/**
 * Vault field-name grammar (#2699) — the ONE parser for `<namespace>:<name>`
 * field names. Every vault route that reads or writes a field name, the admin
 * Set dialog, and every helper that asks "which namespace is this field in?"
 * delegates here; nothing else may `split(':')`, `startsWith('<ns>:')`, or carry
 * its own field-name regex (pinned by `__tests__/field-grammar.consistency.test.ts`).
 *
 * Client-safe by design: imported by `app/admin/vault/*` client components, so
 * this module must never pull in a server-only dependency (db, node:crypto, …).
 *
 * ## Grammar
 *   field     = segment *( ":" segment )
 *   segment   = ALNUM *( ALNUM / "." / "_" / "-" )
 *
 * The first segment is the NAMESPACE when more than one segment is present;
 * everything after the first `:` is the NAME (and may itself contain colons,
 * e.g. a DID: `discord-bot-token:did:imajin:abc`). A single segment has no
 * namespace (`GH_TOKEN`, `github-org-provisioning`). Empty segments
 * (`a::b`, `a:`, `:a`), whitespace, and any other character are rejected.
 *
 * Parsing never transforms case or content — whoever types the field name owns
 * the exact string that is looked up later (#2445). The only normalisation is
 * trimming surrounding whitespace, which every route already did.
 */

/** One `:`-delimited segment. Starts alphanumeric; the rest adds `. _ -`. Linear — no nested quantifiers. */
const SEGMENT = /^[a-z\d][\w.-]*$/i;

const SEPARATOR = ':';

/** Namespace of kernel self-provisioned secrets: `internal-secret:<purpose>` (#2245). */
export const INTERNAL_SECRET_NAMESPACE = 'internal-secret';

/** Field-name prefix every self-provisioned internal secret lives under. */
export const INTERNAL_SECRET_FIELD_PREFIX = `${INTERNAL_SECRET_NAMESPACE}${SEPARATOR}`;

/** Namespace of a #2242-minted keypair's sealed private key: `vault-minted-key:<did>`. */
export const MINTED_KEY_NAMESPACE = 'vault-minted-key';

/** Human-readable rule, for UI hints and 400 messages. */
export const VAULT_FIELD_NAME_RULE =
  'letters, digits, and . _ - only, optionally namespaced as <namespace>:<name> with no empty parts (e.g. GH_TOKEN, github-org-provisioning, internal-secret:<purpose>)';

export interface ParsedVaultFieldName {
  /** The trimmed field name — the exact string to store, look up, or sign. */
  field: string;
  /** Text before the first `:`, or `null` for a bare (un-namespaced) field. */
  namespace: string | null;
  /** Text after the first `:` (may contain further colons), or the whole field when bare. */
  name: string;
}

export type VaultFieldNameParse =
  | { ok: true; value: ParsedVaultFieldName }
  | { ok: false; reason: 'required' | 'invalid'; message: string };

/**
 * Parse an untrusted value (request body / route param / form input) into a
 * vault field name. Pure — no side effects, no case folding.
 */
export function parseVaultFieldName(input: unknown): VaultFieldNameParse {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, reason: 'required', message: 'field is required' };
  }
  const field = input.trim();
  const segments = field.split(SEPARATOR);
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    return { ok: false, reason: 'invalid', message: `field is not a valid vault field name: ${VAULT_FIELD_NAME_RULE}` };
  }
  const [first, ...rest] = segments;
  return rest.length === 0
    ? { ok: true, value: { field, namespace: null, name: first } }
    : { ok: true, value: { field, namespace: first, name: rest.join(SEPARATOR) } };
}

/** True when `field` parses under the grammar. */
export function isValidVaultFieldName(field: unknown): boolean {
  return parseVaultFieldName(field).ok;
}

/** The namespace of `field`, or `null` when it is bare or does not parse. */
export function vaultFieldNamespace(field: string): string | null {
  const parsed = parseVaultFieldName(field);
  return parsed.ok ? parsed.value.namespace : null;
}

/** Legacy ENV_STYLE token (`GH_TOKEN`): upper-case letters, digits, underscores. */
const ENV_STYLE = /^[A-Z\d_]+$/;

/** True for a bare (un-namespaced) legacy ENV_STYLE field such as `GH_TOKEN`. */
export function isEnvStyleFieldName(field: string): boolean {
  const parsed = parseVaultFieldName(field);
  return parsed.ok && parsed.value.namespace === null && ENV_STYLE.test(parsed.value.name);
}

/** True when `field` is an `internal-secret:*` field (#2446 — rotation routes these specially). */
export function isInternalSecretField(field: string): boolean {
  return vaultFieldNamespace(field) === INTERNAL_SECRET_NAMESPACE;
}

/** True when `field` is a `vault-minted-key:*` field (#2242). */
export function isMintedKeyField(field: string): boolean {
  return vaultFieldNamespace(field) === MINTED_KEY_NAMESPACE;
}
