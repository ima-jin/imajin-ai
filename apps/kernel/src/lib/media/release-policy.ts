// Relative (not "@/") so the module resolves under the test runner, which loads
// these media modules for real rather than mocking them.
import { parseFrontmatter } from "./frontmatter";

/**
 * Release-rule header schema + parser (#1206), extends the #1193 frontmatter
 * vocabulary.
 *
 * A `.fair`-signed userspace document is the SOURCE OF TRUTH and the trigger
 * surface (#1205); its header ALSO carries the per-field/row RELEASE policy
 * that decides what may materialize into the DB projection (#1207). This module
 * parses that policy WITHOUT touching the existing article codec
 * (serialize/parseFrontmatter/buildArticleBlock) — the two headers coexist in
 * the same YAML block, so a document can be both an article (#1193) and a
 * release-gated control-plane document at once.
 *
 * Discipline rule 2 (the trigger doc must be at least as protected as what it
 * discloses): a release override may only TIGHTEN. Any header that tries to
 * WIDEN disclosure past what the #1196 consent 2x2 permits is a validation
 * failure — we fail closed, mirroring the `{ error: string }` return of
 * `buildArticleBlock()`.
 *
 * Tier types, ordering, and #1196 derivation now live in packages/fair (#1453).
 * They are re-exported here under their original names so all existing callers
 * (tests, projection reactor, etc.) continue to work without import changes.
 */

// ── Canonical tier types (re-exported from @imajin/fair) ─────────────────────

// Alias so existing callers that use `ReleaseTier` still work.
export type { FairReleaseTier as ReleaseTier } from "@imajin/fair";
export type { FieldClassification } from "@imajin/fair";
export {
  FAIR_RELEASE_TIERS as RELEASE_TIERS,
  TIER_RANK,
  deriveReleaseTier,
} from "@imajin/fair";

// Import locally for use in the parse pipeline below.
import {
  FAIR_RELEASE_TIERS as RELEASE_TIERS,
  TIER_RANK,
  deriveReleaseTier,
  type FairReleaseTier as ReleaseTier,
} from "@imajin/fair";

// ── Asset-side parse pipeline (stays here — depends on frontmatter) ─────────

/** Proof grade carried alongside a released field. */
export type ProofGrade = "signed" | "asserted";

export const PROOF_GRADES: readonly ProofGrade[] = ["signed", "asserted"] as const;

/** The resolved, typed release policy for a single field/row (the shape #1207 consumes). */
export interface FieldReleasePolicy {
  /** The effective release tier after applying any (tightening) override. */
  release: ReleaseTier;
  /** Optional viewer scope this field is released to. */
  viewer?: string;
  /** Proof grade for the released value (defaults to `asserted`). */
  proof_grade: ProofGrade;
}

/** Per-field release policy keyed by field/row name. */
export type ReleasePolicy = Record<string, FieldReleasePolicy>;

/** Success = truth-data + body (from #1193) PLUS the typed release policy. */
export interface ParsedReleasePolicy {
  data: Record<string, unknown>;
  body: string;
  releasePolicy: ReleasePolicy;
}

function isReleaseTier(value: unknown): value is ReleaseTier {
  return typeof value === "string" && (RELEASE_TIERS as readonly string[]).includes(value);
}

function isProofGrade(value: unknown): value is ProofGrade {
  return typeof value === "string" && (PROOF_GRADES as readonly string[]).includes(value);
}

/**
 * Read a boolean classification axis. STRICT-on-missing / fail-closed: a
 * missing axis defaults to the MORE PROTECTIVE value (`true`), so an
 * unclassified field derives the most restrictive tier and cannot be widened
 * without explicitly declaring itself `self` / not-`sensitive`.
 * A present-but-non-boolean value is a hard error.
 */
function readAxis(
  raw: Record<string, unknown>,
  key: string,
  field: string,
): { value: boolean } | { error: string } {
  const value = raw[key];
  if (value === undefined) return { value: true };
  if (typeof value !== "boolean") {
    return { error: `release policy for field "${field}": ${key} must be a boolean` };
  }
  return { value };
}

/**
 * Parse and validate a single field's release entry.
 *
 * The entry declares its #1196 classification (`discloses_others`, `sensitive`)
 * from which the default tier is derived. An optional `release:` override may
 * only TIGHTEN; a widening override is a validation failure (rule 2).
 */
function parseFieldEntry(
  field: string,
  entry: unknown,
): { policy: FieldReleasePolicy } | { error: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { error: `release policy for field "${field}": entry must be a mapping` };
  }
  const raw = entry as Record<string, unknown>;

  const disclosesOthers = readAxis(raw, "discloses_others", field);
  if ("error" in disclosesOthers) return { error: disclosesOthers.error };
  const sensitive = readAxis(raw, "sensitive", field);
  if ("error" in sensitive) return { error: sensitive.error };

  const derived = deriveReleaseTier({
    disclosesOthers: disclosesOthers.value,
    sensitive: sensitive.value,
  });

  // Explicit override may only tighten (be at least as restrictive as derived).
  let release: ReleaseTier = derived;
  if (raw.release !== undefined) {
    if (!isReleaseTier(raw.release)) {
      return {
        error: `release policy for field "${field}": invalid release tier ${JSON.stringify(
          raw.release,
        )} (expected ${RELEASE_TIERS.join(" | ")})`,
      };
    }
    const overrideTier: ReleaseTier = raw.release;
    if (TIER_RANK[overrideTier] < TIER_RANK[derived]) {
      return {
        error: `release policy for field "${field}": release "${overrideTier}" widens disclosure past the derived tier "${derived}" (overrides may only tighten)`,
      };
    }
    release = overrideTier;
  }

  if (raw.viewer !== undefined && typeof raw.viewer !== "string") {
    return { error: `release policy for field "${field}": viewer must be a string scope` };
  }

  if (raw.proof_grade !== undefined && !isProofGrade(raw.proof_grade)) {
    return {
      error: `release policy for field "${field}": invalid proof_grade ${JSON.stringify(
        raw.proof_grade,
      )} (expected ${PROOF_GRADES.join(" | ")})`,
    };
  }

  const policy: FieldReleasePolicy = {
    release,
    proof_grade: (raw.proof_grade as ProofGrade | undefined) ?? "asserted",
    ...(typeof raw.viewer === "string" ? { viewer: raw.viewer } : {}),
  };
  return { policy };
}

/**
 * Parse the release policy out of a document header, composing with #1193
 * `parseFrontmatter()`. Returns the full truth-data + body PLUS a typed,
 * validated release policy keyed by field/row.
 *
 * A document with no `release:` block is valid and yields an empty policy — it
 * simply has no gated fields. A malformed or over-broad claim fails closed with
 * a human-readable message (mirrors `buildArticleBlock()`).
 */
export function parseReleasePolicy(
  markdown: string,
): ParsedReleasePolicy | { error: string } {
  const { data, body } = parseFrontmatter(markdown);

  const rawRelease = data.release;
  if (rawRelease === undefined) {
    return { data, body, releasePolicy: {} };
  }
  if (typeof rawRelease !== "object" || rawRelease === null || Array.isArray(rawRelease)) {
    return { error: "release must be a mapping of field name to release rule" };
  }

  const releasePolicy: ReleasePolicy = {};
  for (const [field, entry] of Object.entries(rawRelease as Record<string, unknown>)) {
    const parsed = parseFieldEntry(field, entry);
    if ("error" in parsed) return { error: parsed.error };
    releasePolicy[field] = parsed.policy;
  }

  return { data, body, releasePolicy };
}
