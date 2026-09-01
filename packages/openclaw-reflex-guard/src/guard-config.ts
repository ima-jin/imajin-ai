/**
 * Layer 1 config surface (issue #1252 acceptance: "Sealed-term list ... live
 * in config/memory, not hardcoded"). This module never contains a real
 * sealed term — see `config/sealed-terms.example.json` for the shape an
 * operator copies into their own `openclaw.json`.
 */

/** One entry in `plugins.entries.reflex-guard.config.guard.terms` (openclaw.json). */
export interface SealedTermConfig {
  /** Stable id, used in audit-log records and nowhere else — never the sealed phrase itself. */
  id: string;
  /** Literal substring (case-insensitive) or a regex source string, depending on `type`. */
  pattern: string;
  /** Defaults to "literal". */
  type?: "literal" | "regex";
  /** Regex flags, only used when `type === "regex"`. Defaults to "i". */
  flags?: string;
  /** "block" cancels delivery; "flag" only audit-logs the trip and lets the message through. */
  action: "block" | "flag";
  /** Human-readable operator note. NEVER the sealed phrase itself. */
  description?: string;
}

/** `plugins.entries.reflex-guard.config.guard` (openclaw.json). */
export interface OutboundGuardConfig {
  /** Explicit opt-out. Defaults to true. */
  enabled?: boolean;
  terms?: SealedTermConfig[];
  /** JSONL path for guard trip records. Defaults to `reflex-guard/audit-log.jsonl`. */
  auditLogPath?: string;
}

/** A term whose pattern/regex has already been validated and compiled to a matcher. */
export interface CompiledSealedTerm {
  id: string;
  action: "block" | "flag";
  test: (content: string) => boolean;
}

export interface ResolvedOutboundGuardConfig {
  enabled: boolean;
  terms: CompiledSealedTerm[];
  auditLogPath: string;
  /**
   * ids of terms present in config but dropped for being malformed. Never
   * silent: `resolveOutboundGuardConfig` also calls `warn` once per dropped
   * term (see "Decisions for review" in the PR description for why a single
   * malformed term is dropped rather than disabling the whole guard).
   */
  invalidTermIds: string[];
}

export const DEFAULT_AUDIT_LOG_PATH = "reflex-guard/audit-log.jsonl";

export type CompileTermOutcome =
  | { ok: true; term: CompiledSealedTerm }
  | { ok: false; id?: string; reason: string };

/** Validates and compiles a single raw term config into a matcher. Never throws. */
export function compileTerm(raw: SealedTermConfig): CompileTermOutcome {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "sealed term entry must be an object" };
  }
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    return { ok: false, reason: "sealed term is missing a non-empty string id" };
  }
  if (typeof raw.pattern !== "string" || raw.pattern.length === 0) {
    return { ok: false, id: raw.id, reason: "pattern must be a non-empty string" };
  }
  if (raw.action !== "block" && raw.action !== "flag") {
    return { ok: false, id: raw.id, reason: 'action must be "block" or "flag"' };
  }

  if (raw.type === "regex") {
    try {
      const compiled = new RegExp(raw.pattern, raw.flags ?? "i");
      return {
        ok: true,
        term: { id: raw.id, action: raw.action, test: (content: string) => compiled.test(content) },
      };
    } catch (err) {
      return {
        ok: false,
        id: raw.id,
        reason: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const needle = raw.pattern.toLowerCase();
  return {
    ok: true,
    term: { id: raw.id, action: raw.action, test: (content: string) => content.toLowerCase().includes(needle) },
  };
}

/**
 * Resolves the effective Layer 1 guard config. A malformed individual term
 * is dropped (not silently — `warn` is always called) rather than disabling
 * the whole guard over one bad entry; `enabled` defaults to `true` so the
 * guard only goes fully inert on an explicit `enabled: false` or an empty
 * `terms` list (the shipped default — see `config/sealed-terms.example.json`).
 */
export function resolveOutboundGuardConfig(
  raw: OutboundGuardConfig | undefined,
  options: { warn?: (message: string) => void } = {},
): ResolvedOutboundGuardConfig {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const enabled = raw?.enabled !== false;
  const rawTerms = Array.isArray(raw?.terms) ? raw.terms : [];

  const terms: CompiledSealedTerm[] = [];
  const invalidTermIds: string[] = [];
  for (const rawTerm of rawTerms) {
    const outcome = compileTerm(rawTerm);
    if (outcome.ok) {
      terms.push(outcome.term);
    } else {
      invalidTermIds.push(outcome.id ?? "(unknown)");
      warn(
        `[reflex-guard] dropping invalid sealed term ${outcome.id ? `"${outcome.id}"` : ""}: ${outcome.reason}`,
      );
    }
  }

  const auditLogPath =
    typeof raw?.auditLogPath === "string" && raw.auditLogPath.trim().length > 0
      ? raw.auditLogPath
      : DEFAULT_AUDIT_LOG_PATH;

  return { enabled, terms, auditLogPath, invalidTermIds };
}
