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
 * match (`github-org-provisioning` -> `GITHUB-ORG-PROVISIONING` ->
 * `OrgCredentialMissingError`, live on prod 2026-09-29).
 *
 * Four field-name shapes are in live use in this codebase:
 *   - lowercase-hyphen:  `github-org-provisioning`            (org-provisioning.ts)
 *   - namespaced:        `internal-secret:<purpose>`          (internal-secret.ts;
 *                        `<purpose>` itself may contain dots, e.g.
 *                        `kernel.attestation-internal-api-key`)
 *   - connector:         `<purpose>:did:<method>:<id>`, optionally with a
 *                        trailing `:<yyyy-mm-dd>` window suffix
 *                        (connector-static-secret.ts, e.g.
 *                        `warp-agent-key:did:imajin:<id>`;
 *                        usage/rollup.ts, e.g.
 *                        `usage-rollup:did:imajin:<id>:2026-09-29`).
 *                        `<id>` is the DID's method-specific-id and is
 *                        genuinely MIXED-CASE in production — real DIDs are
 *                        minted as base58 (`bs58.encode`, auth/crypto.ts) or
 *                        nanoid(44) (default alphabet `A-Za-z0-9_-`,
 *                        foreign-principal-stub.ts / claimable-stub.ts), not
 *                        as lowercase hex. An earlier version of this
 *                        grammar only accepted a lowercase `<id>` — a toy
 *                        shape that happened to pass tests but rejected
 *                        every DID the kernel actually mints (review on
 *                        #2449, tracked under #2450).
 *   - legacy ENV_STYLE:  `GH_TOKEN`
 *
 * {@link isValidVaultFieldName} validates against this grammar; it never
 * transforms the input. Whoever types the field name owns the exact string
 * that gets looked up later — the tool's job is to refuse something clearly
 * wrong (spaces, an empty segment, a shape matching none of the above),
 * never to "fix" it into something the operator didn't type.
 */

/** Lowercase-hyphen/dot purpose token: `foo`, `foo-bar`, `kernel.attestation-internal-api-key`. */
const LOWER_SEGMENT = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

/** Legacy env-style token: `GH_TOKEN`, `ENV_STYLE`. Never seen with a colon in it. */
const ENV_SEGMENT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** DID method name — the segment right after the literal `did` — always lowercase per the DID spec, e.g. `imajin`. */
const DID_METHOD_SEGMENT = /^[a-z][a-z0-9]*$/;

/**
 * DID method-specific-id: the DID-spec charset (`[A-Za-z0-9._%-]+`), which is
 * what both base58 (`bs58.encode`) and nanoid's default alphabet land inside.
 * Deliberately mixed-case — see this module's docblock.
 */
const DID_ID_SEGMENT = /^[A-Za-z0-9._%-]+$/;

/** A `usage-rollup:...:<yyyy-mm-dd>` window suffix. */
const DATE_SEGMENT = /^\d{4}-\d{2}-\d{2}$/;

/** Namespace literal for `internal-secret:<purpose>` fields (internal-secret.ts). */
const INTERNAL_SECRET_NAMESPACE = 'internal-secret';

/** Rule text shown inline next to the add dialog's field input. */
export const VAULT_FIELD_NAME_RULE =
  'lowercase-hyphen (github-org-provisioning), namespaced (internal-secret:<purpose>), ' +
  'connector (<purpose>:did:<method>:<id>, optionally :<yyyy-mm-dd> - <id> may be mixed-case), ' +
  'or legacy ENV_STYLE (GH_TOKEN) - typed exactly as shown, never uppercased for you';

/**
 * Validate a field name against the grammar above. Pure - no transform, no
 * side effects.
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

  if (segments.length === 2 && segments[0] === INTERNAL_SECRET_NAMESPACE) {
    return LOWER_SEGMENT.test(segments[1]);
  }

  // Connector shape: <purpose>:did:<method>:<id>[:<yyyy-mm-dd>].
  if (segments.length === 4 || segments.length === 5) {
    const [purpose, didLiteral, method, id, dateSuffix] = segments;
    return (
      LOWER_SEGMENT.test(purpose) &&
      didLiteral === 'did' &&
      DID_METHOD_SEGMENT.test(method) &&
      DID_ID_SEGMENT.test(id) &&
      (segments.length === 4 || DATE_SEGMENT.test(dateSuffix))
    );
  }

  return false;
}

export type VaultCustodyScheme = 'node-sealed' | 'delegation-grant';

/**
 * Literal mirror of `GITHUB_ORG_CREDENTIAL_FIELD`
 * (`../github/org-provisioning.ts`) - see this module's docblock for why it
 * is not imported directly.
 */
export const GITHUB_ORG_CREDENTIAL_FIELD_NAME = 'github-org-provisioning';

/** Namespace prefix for kernel-internal, self-provisioned secrets (internal-secret.ts). */
export const INTERNAL_SECRET_FIELD_PREFIX = `${INTERNAL_SECRET_NAMESPACE}:`;

export interface VaultCustodyDefault {
  scheme: VaultCustodyScheme;
  /** true when the kernel's own reader hard-requires this scheme - the selector should be disabled, not merely defaulted. */
  locked: boolean;
  /** One-line reason, shown next to the selector whenever `locked` is true. */
  why?: string;
}

/**
 * Default (and, for fields the kernel hard-requires it for, LOCK) the
 * custody scheme the add dialog proposes for a given field name (#2445
 * defect 2: "add form can't choose custody... fields that require
 * delegation-grant have no way to say so").
 */
export function defaultCustodyForField(field: string): VaultCustodyDefault {
  const trimmed = field.trim();
  if (trimmed === GITHUB_ORG_CREDENTIAL_FIELD_NAME) {
    return {
      scheme: 'delegation-grant',
      locked: true,
      why: 'org-provisioning.ts (loadOrgCredential) reads this field only through the v2 delegation-grant path - a node-sealed entry is invisible to apps.provision.',
    };
  }
  if (trimmed.startsWith(INTERNAL_SECRET_FIELD_PREFIX)) {
    return {
      scheme: 'delegation-grant',
      locked: true,
      why: 'getInternalSecret() reads internal-secret:* fields only through the v2 delegation-grant self-grant path (internal-secret.ts) - a node-sealed entry would be silently unreadable.',
    };
  }
  return { scheme: 'node-sealed', locked: false };
}

/**
 * True for `internal-secret:*` fields (#2450 DECISION a): these are kernel
 * self-provisioned (#2245 ruling - a human only replaces or destroys them
 * via Rotate's countersigned path, never Set or Delete). Used to refuse
 * Set/Delete on these names in both the client dialogs and the server
 * routes.
 */
export function isInternalSecretField(field: string): boolean {
  return field.trim().startsWith(INTERNAL_SECRET_FIELD_PREFIX);
}
