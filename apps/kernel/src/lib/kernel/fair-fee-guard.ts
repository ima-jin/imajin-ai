import type { FairEntry, FairFee } from "@imajin/fair";
import { buildFairManifest } from "@imajin/fair";

/**
 * Fee-split guard for `.fair` manifest writes (#1937 / A08).
 *
 * `PUT /media/api/assets/[id]/fair` lets the asset owner submit an entire
 * replacement manifest (v1.0 or v1.1), but the protocol/node/platform fee
 * split (`chain`), the collaborator payout split (`distributions`), and the
 * processor fee schedule (`fees`) are NOT owner-editable on either version —
 * they describe how money is divided at settlement time and must always
 * match what the node itself would derive for this asset via
 * {@link buildFairManifest}. Everything else on the manifest (`access`,
 * `terms`, `attribution`, `transfer`, `distribution`, `training`,
 * `commercial`, `settlement`, `tipping`, `intent`, `provenance`, `source`)
 * remains fully owner-controlled.
 *
 * This is enforced for v1.0 submissions too, not just v1.1: `POST
 * /upgrade-fair` reads `chain`/`fees` straight from whatever is already
 * stored on the asset (`v1_0.chain ?? defaults.chain` in
 * packages/fair/src/upgrade.ts) and hands it to `signFairAsNode()` — so a
 * tampered v1.0 chain written through this route unchecked would still end
 * up node-signed once upgraded.
 *
 * The route re-derives these fields server-side and either rejects the
 * write (when the owner submitted a conflicting value) or fills them in
 * (when omitted) — it never trusts owner-supplied fee data verbatim.
 */

const SHARE_EPSILON = 1e-9;

/** Shape shared by both `FairManifestV1_0` and `FairManifestV1_1` for the fields this guard protects. */
export interface FairFeeCarrier {
  chain?: FairEntry[];
  fees?: FairFee[];
  distributions?: FairEntry[];
}

export interface ProtectedFairFields {
  chain: FairEntry[];
  fees: FairFee[];
  distributions: FairEntry[];
}

export interface ProtectedFieldMismatch {
  /** Dot/bracket path of the offending field, e.g. `chain[1].did`. */
  field: string;
  message: string;
}

/**
 * Derive the protocol/node/platform fee split, processor fee schedule, and
 * default payout distribution for an asset. Mirrors the fixed formula in
 * `getDefaultManifest` (packages/fair/src/templates.ts) — no per-node or
 * per-request overrides exist today, so this is fully deterministic given
 * only the asset's owner.
 */
export function deriveProtectedFairFields(asset: {
  id: string;
  ownerDid: string;
  mimeType: string;
}): ProtectedFairFields {
  const built = buildFairManifest({
    creatorDid: asset.ownerDid,
    contentDid: asset.id,
    contentType: asset.mimeType,
  });
  return {
    chain: built.chain,
    fees: built.fees,
    distributions: built.distributions,
  };
}

function shareMismatches(a: unknown, b: number): boolean {
  return typeof a !== "number" || !Number.isFinite(a) || Math.abs(a - b) > SHARE_EPSILON;
}

function compareEntryList(
  label: "chain" | "distributions",
  submitted: unknown,
  expected: FairEntry[],
): ProtectedFieldMismatch | null {
  // Not owner-supplied — the caller fills it in from the canonical value.
  if (submitted === undefined) return null;

  if (!Array.isArray(submitted)) {
    return { field: label, message: `${label} must be an array` };
  }
  if (submitted.length !== expected.length) {
    return {
      field: label,
      message: `${label} must have exactly ${expected.length} entries — the fee split is server-derived and cannot have entries added or removed`,
    };
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!;
    const got = submitted[i] as unknown;
    if (typeof got !== "object" || got === null) {
      return { field: `${label}[${i}]`, message: `${label}[${i}] must be an object` };
    }
    const g = got as Record<string, unknown>;
    if (g.role !== exp.role) {
      return {
        field: `${label}[${i}].role`,
        message: `${label}[${i}].role must be "${exp.role}" — the fee split's roles and order are server-derived`,
      };
    }
    if ((g.did ?? undefined) !== (exp.did ?? undefined)) {
      return {
        field: `${label}[${i}].did`,
        message: `${label}[${i}].did for role "${exp.role}" does not match the server-derived recipient`,
      };
    }
    if (shareMismatches(g.share, exp.share)) {
      return {
        field: `${label}[${i}].share`,
        message: `${label}[${i}].share for role "${exp.role}" does not match the server-derived fee split (expected ${exp.share})`,
      };
    }
  }
  return null;
}

function compareFees(submitted: unknown, expected: FairFee[]): ProtectedFieldMismatch | null {
  if (submitted === undefined) return null;

  if (!Array.isArray(submitted)) {
    return { field: "fees", message: "fees must be an array" };
  }
  if (submitted.length !== expected.length) {
    return {
      field: "fees",
      message: `fees must have exactly ${expected.length} entries — the processor fee schedule is server-derived`,
    };
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!;
    const got = submitted[i] as unknown;
    if (typeof got !== "object" || got === null) {
      return { field: `fees[${i}]`, message: `fees[${i}] must be an object` };
    }
    const g = got as Record<string, unknown>;
    if (
      g.role !== exp.role ||
      g.name !== exp.name ||
      g.rateBps !== exp.rateBps ||
      g.fixedCents !== exp.fixedCents ||
      (g.minRateBps ?? undefined) !== (exp.minRateBps ?? undefined)
    ) {
      return {
        field: `fees[${i}]`,
        message: `fees[${i}] does not match the server-derived processor fee schedule`,
      };
    }
  }
  return null;
}

/**
 * Check the owner-submitted manifest's `chain`, `distributions`, and `fees`
 * fields against the server-derived canonical values. Returns the first
 * mismatch found, or `null` when everything present matches (fields the
 * owner omitted entirely are not flagged — they get filled in by
 * {@link applyProtectedFairFields}).
 */
export function checkProtectedFairFields<T extends FairFeeCarrier>(
  manifest: T,
  expected: ProtectedFairFields,
): ProtectedFieldMismatch | null {
  return (
    compareEntryList("chain", manifest.chain, expected.chain) ??
    compareEntryList("distributions", manifest.distributions, expected.distributions) ??
    compareFees(manifest.fees, expected.fees)
  );
}

/**
 * Merge the server-derived protected fields into an owner-submitted
 * manifest. `chain` and `fees` are always set to the canonical value (every
 * manifest carries a fee split); `distributions` is only added when the
 * owner's submission already included one, since it's an optional
 * backward-compat alias most manifests never set.
 */
export function applyProtectedFairFields<T extends FairFeeCarrier>(
  manifest: T,
  expected: ProtectedFairFields,
): T {
  const merged: T = {
    ...manifest,
    chain: expected.chain,
    fees: expected.fees,
  };
  if (manifest.distributions !== undefined) {
    merged.distributions = expected.distributions;
  }
  return merged;
}
