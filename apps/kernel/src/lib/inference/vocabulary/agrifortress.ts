/**
 * AgriFortress vocabulary (#1216) — first real tenant mount.
 *
 * Forcing function: AgriFortress (catalyst-power/xprize#5) ships on the
 * Aug 17 XPRIZE clock. This is the first concrete vocabulary that proves
 * the engine's breadth (AgriFortress supply + Artifact operator = two tenants,
 * same shell, no fork).
 *
 * Intent types:
 *   supply.received   → farmer records receiving a supply delivery (voice primary)
 *   lot.opened        → farmer opens a new supply lot / batch
 *   delivery.noted    → farmer notes a delivery for later reconciliation
 *
 * ALL intents are 'deliberate' — the one-confirm tap IS the consent gate.
 * AgriFortress: voice = count + intent; photo = evidence, NOT measurement.
 *
 * Model: none declared. The farmer's own sealed connector card decides which
 * brain runs this vocabulary (#1621).
 *
 * Hard boundary: resolve() MUST NOT import Imajin kernel internals.
 *
 * Resolution (#1850): resolve() ONLY produces a stub attestation receipt
 * (digest + resolvedAt) here. It never calls out to a tenant supply API —
 * that endpoint (`/supply/events`) never existed on the platform. Lot
 * materialization is handled app-side: the xprize app calls the kernel's own
 * `/supply/api/received` route post-inference-confirm (catalyst-power/xprize#92).
 * `AGRIFORTRESS_SUPPLY_API_URL` / `AGRIFORTRESS_SUPPLY_API_KEY` are xprize-only
 * env vars now — the kernel resolver reads neither.
 */

import { createHash } from 'node:crypto';
import type {
  IntentVocabulary,
  CandidateIntent,
  ConsentTier,
  ResolutionReceipt,
  MetadataValidationResult,
} from './contract';

export const agrifortressVocabulary: IntentVocabulary = {
  name: 'agrifortress',

  systemPrompt: `
You are the AgriFortress supply-chain inference engine. A farmer speaks a voice note
describing supply activity. Extract the intent from the following vocabulary:

- supply.received   → a party received a delivery (lot) and signs to confirm receipt (commodity-agnostic: eggs, seeds, fertiliser, tools, etc.)
- lot.opened        → farmer is opening a new batch or lot for tracking
- delivery.noted    → farmer is noting a delivery for later reconciliation (no immediate action)

For each candidate, extract a metadata object with these fields (omit unknown fields):
  product:   string   (what was received, e.g. "maize seed", "fertiliser")
  qty:       number   (quantity, if mentioned)
  unit:      string   (unit of quantity, e.g. "kg", "bags", "litres")
  recipient: string   (who it's for, if mentioned — often the farmer themselves)
  lot:       string   (lot or batch identifier, if mentioned)
  notes:     string   (any other relevant detail)

Produce a ranked JSON array of candidate intents.
`.trim(),

  resolveConsentTier(_intentType: string): ConsentTier {
    // ALL AgriFortress intents require deliberate confirmation — one-confirm tap.
    return 'deliberate';
  },

  /**
   * Validate a human-edited/confirmed metadata payload (#1789) — e.g. a
   * corrected recipient, lot, notes, or line items from the confirm card.
   * Known fields are type-checked when present; unrecognised extra fields are
   * allowed so a forward-compatible client isn't rejected for sending fields
   * this vocabulary doesn't read yet.
   */
  validateMetadata(_intentType: string, metadata: unknown): MetadataValidationResult {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return { ok: false, error: 'metadata must be a JSON object' };
    }
    const m = metadata as Record<string, unknown>;

    return (
      validateOptionalStringFields(m) ??
      validateOptionalQty(m) ??
      validateOptionalLines(m) ?? { ok: true, metadata: m }
    );
  },

  async resolve(intent: CandidateIntent, ownerDid: string): Promise<ResolutionReceipt> {
    return resolveAgriFortressIntent(intent, ownerDid);
  },
};

// ---------------------------------------------------------------------------
// validateMetadata helpers (#1789) — each checks one optional field group and
// returns undefined (pass) or a fail-closed MetadataValidationResult.
// ---------------------------------------------------------------------------

const OPTIONAL_STRING_FIELDS = ['product', 'unit', 'recipient', 'lot', 'notes'] as const;

function validateOptionalStringFields(m: Record<string, unknown>): MetadataValidationResult | undefined {
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = m[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { ok: false, error: `metadata.${field} must be a string` };
    }
  }
  return undefined;
}

function validateOptionalQty(m: Record<string, unknown>): MetadataValidationResult | undefined {
  if (m['qty'] !== undefined && m['qty'] !== null && typeof m['qty'] !== 'number') {
    return { ok: false, error: 'metadata.qty must be a number' };
  }
  return undefined;
}

function validateOptionalLines(m: Record<string, unknown>): MetadataValidationResult | undefined {
  const lines = m['lines'];
  if (lines === undefined || lines === null) return undefined;
  if (!Array.isArray(lines)) {
    return { ok: false, error: 'metadata.lines must be an array' };
  }
  const hasInvalidEntry = lines.some(
    (line) => typeof line !== 'object' || line === null || Array.isArray(line),
  );
  if (hasInvalidEntry) {
    return { ok: false, error: 'metadata.lines entries must be objects' };
  }
  return undefined;
}

/**
 * Produce a stub attestation receipt (#1850).
 *
 * The kernel resolver never calls a tenant supply API — it only attests
 * (digest + timestamp) that the intent was resolved. Lot materialization is
 * the xprize app's responsibility, via its own post-confirm call to the
 * kernel's `/supply/api/received` route (catalyst-power/xprize#92).
 */
function resolveAgriFortressIntent(intent: CandidateIntent, ownerDid: string): ResolutionReceipt {
  const resolvedAt = new Date().toISOString();
  const payload = {
    intentType: intent.intentType,
    ownerDid,
    metadata: intent.metadata,
    resolvedAt,
  };
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return {
    primitiveType: intent.intentType,
    digest,
    resolvedAt,
  };
}
