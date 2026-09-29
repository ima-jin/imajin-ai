/**
 * Vault field-name grammar + custody defaults (#2445).
 *
 * Client-safe by design: this module is imported directly by the
 * `set-secret-dialog.tsx` client component, so it must never pull in a
 * server-only dependency (db, node:crypto, libsodium, …). That is also why
 * {@link GITHUB_ORG_CREDENTIAL_FIELD_NAME} below is a literal string rather
 * than an import of `GITHUB_ORG_CREDENTIAL_FIELD` from
 * `../github/org-provisioning` — that module drags in `libsodium-wrappers`
 * and `node:crypto`, which have no business in a client bundle.
 * `./__tests__/field-grammar.consistency.test.ts` (server-side only) pins
 * the literal here against the real export so the two can't drift silently.
 *
 * ## The defect this fixes (#2445)
 * The add dialog used to `field.trim().toUpperCase()` every field name —
 * built for the one legacy `ENV_STYLE` shape. Every namespaced field added
 * since (#2245 internal secrets, #2416 org-provisioning, #1439 connector
 * static secrets) is lowercase/hyphenated, and case-folding it silently
 * breaks the kernel's own loaders, which look the field up by exact string
 * match (`github-org-provisioning` → `GITHUB-ORG-PROVISIONING` →
 * `OrgCredentialMissingError`, live on prod 2026-09-29).
 *
 * Four field-name shapes are in live use in this codebase:
 *   - lowercase-hyphen:  `github-org-provisioning`            (org-provisioning.ts)
 *   - namespaced:        `internal-secret:<purpose>`          (internal-secret.ts;
 *                        `<purpose>` itself may contain dots, e.g.
 *                        `kernel.attestation-internal-api-key`)
 *   - connector:         `<purpose>:<did>`                    (connector-static-secret.ts,
 *                        e.g. `warp-agent-key:did:imajin:…`)
 *   - legacy ENV_STYLE:  `GH_TOKEN`
 *
 * {@link isValidVaultFieldName} validates against this grammar; it never
 * transforms the input. Whoever types the field name owns the exact string
 * that gets looked up later — the tool's job is to refuse something clearly
 * wrong (spaces, mixed case within a segment, an empty segment), never to
 * "fix" it into something the operator didn't type.
 */

/** Lowercase token, optionally hyphen/dot-joined: `foo`, `foo-bar`, `kernel.attestation-internal-api-key`. */
const LOWER_SEGMENT = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

/** Legacy env-style token: `GH_TOKEN`, `ENV_STYLE`. Never seen with a colon in it. */
const ENV_SEGMENT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Rule text shown inline next to the add dialog's field input. */
export const VAULT_FIELD_NAME_RULE =
  'lowercase-hyphen (github-org-provisioning), namespaced (internal-secret:<purpose>), ' +
  'connector (<purpose>:<did>), or legacy ENV_STYLE (GH_TOKEN) — typed exactly as shown, never uppercased for you';

/**
 * Validate a field name against the grammar above. Pure — no transform, no
 * side effects. A single-segment (no `:`) name may be either the lowercase
 * shape or the legacy ENV_STYLE shape; a multi-segment (namespaced or
 * connector) name requires every segment to be lowercase — legacy fields
 * are never namespaced.
 */
export function isValidVaultFieldName(field: string): boolean {
  const trimmed = field.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const segments = trimmed.split(':');
  if (segments.some((segment) => segment.length === 0)) {
    return false;
  }
  if (segments.length === 1) {
    const [only] = segments;
    return LOWER_SEGMENT.test(only) || ENV_SEGMENT.test(only);
  }
  return segments.every((segment) => LOWER_SEGMENT.test(segment));
}

export type VaultCustodyScheme = 'node-sealed' | 'delegation-grant';

/**
 * Literal mirror of `GITHUB_ORG_CREDENTIAL_FIELD`
 * (`../github/org-provisioning.ts`) — see this module's docblock for why it
 * is not imported directly.
 */
export const GITHUB_ORG_CREDENTIAL_FIELD_NAME = 'github-org-provisioning';

/** Namespace prefix for kernel-internal, self-provisioned secrets (internal-secret.ts). */
export const INTERNAL_SECRET_FIELD_PREFIX = 'internal-secret:';

export interface VaultCustodyDefault {
  scheme: VaultCustodyScheme;
  /** true when the kernel's own reader hard-requires this scheme — the selector should be disabled, not merely defaulted. */
  locked: boolean;
  /** One-line reason, shown next to the selector whenever `locked` is true. */
  why?: string;
}

/**
 * Default (and, for fields the kernel hard-requires it for, LOCK) the
 * custody scheme the add dialog proposes for a given field name (#2445
 * defect 2: "add form can't choose custody… fields that require
 * delegation-grant have no way to say so").
 */
export function defaultCustodyForField(field: string): VaultCustodyDefault {
  const trimmed = field.trim();
  if (trimmed === GITHUB_ORG_CREDENTIAL_FIELD_NAME) {
    return {
      scheme: 'delegation-grant',
      locked: true,
      why: 'org-provisioning.ts (loadOrgCredential) reads this field only through the v2 delegation-grant path — a node-sealed entry is invisible to apps.provision.',
    };
  }
  if (trimmed.startsWith(INTERNAL_SECRET_FIELD_PREFIX)) {
    return {
      scheme: 'delegation-grant',
      locked: true,
      why: 'getInternalSecret() reads internal-secret:* fields only through the v2 delegation-grant self-grant path (internal-secret.ts) — a node-sealed entry would be silently unreadable.',
    };
  }
  return { scheme: 'node-sealed', locked: false };
}
