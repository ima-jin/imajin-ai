import type { FairManifest } from "./types";

const SUM_TOLERANCE = 1e-6;
const VALID_SETTLEMENT_SCHEMES = new Set(["x402", "stripe-link", "mjnx-direct", "solana-pay", "lightning"]);

function validateMoney(m: unknown, path: string): string[] {
  const errors: string[] = [];
  if (typeof m !== "object" || m === null) {
    errors.push(`${path} must be an object`);
    return errors;
  }
  const money = m as Record<string, unknown>;
  if (typeof money.amount !== "number" || !Number.isInteger(money.amount) || money.amount < 0) {
    errors.push(`${path}.amount must be a non-negative integer`);
  }
  if (typeof money.currency !== "string" || !money.currency) {
    errors.push(`${path}.currency must be a non-empty string`);
  } else {
    const c = money.currency;
    if (c !== 'MJNX' && !/^[A-Z]{3}$/.test(c)) {
      errors.push(`${path}.currency must be ISO 4217 3-letter uppercase or 'MJNX'`);
    }
  }
  return errors;
}

function validateDidShareList(list: unknown, path: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(list)) {
    errors.push(`${path} must be an array`);
    return errors;
  }
  if (list.length === 0) {
    errors.push(`${path} must not be empty`);
  }
  let shareSum = 0;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as Record<string, unknown>;
    if (typeof entry.role !== "string" || !entry.role) {
      errors.push(`${path}[${i}].role must be a non-empty string`);
    }
    if (typeof entry.share !== "number" || entry.share < 0 || entry.share > 1) {
      errors.push(`${path}[${i}].share must be a number between 0 and 1`);
    } else {
      shareSum += entry.share;
    }
    if (entry.did !== undefined && (typeof entry.did !== "string" || !entry.did)) {
      errors.push(`${path}[${i}].did must be a non-empty string when present`);
    }
    if (entry.name !== undefined && (typeof entry.name !== "string" || !entry.name)) {
      errors.push(`${path}[${i}].name must be a non-empty string when present`);
    }
  }
  if (Math.abs(shareSum - 1.0) > SUM_TOLERANCE) {
    errors.push(`${path} shares sum to ${shareSum.toFixed(6)}, must be 1.0 (±${SUM_TOLERANCE})`);
  }
  return errors;
}

function validateDistributionRight(right: unknown, path: string): string[] {
  const errors: string[] = [];
  if (typeof right !== "object" || right === null) {
    errors.push(`${path} must be an object`);
    return errors;
  }
  const r = right as Record<string, unknown>;
  if (typeof r.mode !== "string" || !r.mode) {
    errors.push(`${path}.mode must be a non-empty string`);
  }
  if (r.price !== undefined) {
    errors.push(...validateMoney(r.price, `${path}.price`));
  }
  if (r.splits !== undefined) {
    errors.push(...validateDidShareList(r.splits, `${path}.splits`));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Per-section validators — shared between V1.0 and V1.1
// ---------------------------------------------------------------------------

/** Validate the allowedDids array inside an object-form access field. */
function validateAllowedDids(allowedDids: unknown): string[] {
  if (!Array.isArray(allowedDids)) return ["access.allowedDids must be an array"];
  const errors: string[] = [];
  for (const did of allowedDids) {
    if (typeof did !== "string" || !did) errors.push("each allowedDid must be a non-empty string");
  }
  return errors;
}

/** Validate the object form of the access field. */
function validateAccessObject(access: Record<string, unknown>): string[] {
  const validTypes = ["public", "private", "trust-graph", "conversation"];
  const errors: string[] = [];
  if (!validTypes.includes(access.type as string)) {
    errors.push('access.type must be "public", "private", "trust-graph", or "conversation"');
  }
  if (access.type === "conversation" && (typeof access.conversationDid !== "string" || !access.conversationDid)) {
    errors.push('access.conversationDid must be a non-empty string when access.type is "conversation"');
  }
  if (access.allowedDids !== undefined) {
    errors.push(...validateAllowedDids(access.allowedDids));
  }
  return errors;
}

/** Validate the `access` field (string or object form). */
function validateAccess(access: unknown): string[] {
  if (access === undefined || access === null) return ["access is required"];
  if (typeof access === "string") {
    if (access !== "public" && access !== "private") {
      return ['access string must be "public" or "private"'];
    }
    return [];
  }
  if (typeof access === "object") {
    return validateAccessObject(access as Record<string, unknown>);
  }
  return ["access must be a string or object"];
}

/** Validate the `settlement.schemes` array. */
function validateSettlementSchemes(schemes: unknown): string[] {
  if (!Array.isArray(schemes)) return ["settlement.schemes must be an array when present"];
  const errors: string[] = [];
  for (const s of schemes) {
    if (typeof s !== "string" || !VALID_SETTLEMENT_SCHEMES.has(s)) {
      errors.push(`settlement.schemes contains invalid scheme: ${s}`);
    }
  }
  return errors;
}

/** Validate the optional `settlement` block. */
function validateSettlement(settlement: unknown): string[] {
  if (settlement === undefined) return [];
  if (typeof settlement !== "object" || settlement === null) return ["settlement must be an object"];
  const s = settlement as Record<string, unknown>;
  const errors: string[] = [];
  if (s.endpoint !== undefined && typeof s.endpoint !== "string") {
    errors.push("settlement.endpoint must be a string when present");
  }
  if (s.schemes !== undefined) errors.push(...validateSettlementSchemes(s.schemes));
  if (s.fallback !== undefined) {
    if (typeof s.fallback !== "string" || !VALID_SETTLEMENT_SCHEMES.has(s.fallback)) {
      errors.push("settlement.fallback must be a valid settlement scheme");
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// V1.1 section validators
// ---------------------------------------------------------------------------

function validateRequiredFieldsV1_1(m: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (m.fair !== "1.1") errors.push('fair must be "1.1"');
  if (typeof m.id !== "string" || !m.id) errors.push("id is required");
  if (typeof m.type !== "string" || !m.type) errors.push("type is required");
  if (typeof m.owner !== "string" || !m.owner) errors.push("owner (DID) is required");
  if (typeof m.created !== "string" || !m.created) errors.push("created (ISO 8601) is required");
  return errors;
}

function validateTransferV1_1(transfer: unknown): string[] {
  if (transfer === undefined) return [];
  const t = transfer as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof t.allowed !== "boolean") errors.push("transfer.allowed must be a boolean");
  if (t.price !== undefined) errors.push(...validateMoney(t.price, "transfer.price"));
  if (t.resaleRoyaltyBps !== undefined) {
    if (typeof t.resaleRoyaltyBps !== "number" || t.resaleRoyaltyBps < 0 || t.resaleRoyaltyBps > 10000) {
      errors.push("transfer.resaleRoyaltyBps must be a number between 0 and 10000");
    }
  }
  return errors;
}

function validateDistributionV1_1(distribution: unknown): string[] {
  if (distribution === undefined) return [];
  const d = distribution as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["reproduction", "streaming", "derivative", "syndication"] as const) {
    if (d[key] !== undefined) errors.push(...validateDistributionRight(d[key], `distribution.${key}`));
  }
  return errors;
}

function validateTraining(training: unknown): string[] {
  if (training === undefined) return [];
  const t = training as Record<string, unknown>;
  if (typeof t.allowed !== "boolean") return ["training.allowed must be explicitly boolean"];
  return [];
}

function validateCommercial(commercial: unknown): string[] {
  if (commercial === undefined) return [];
  const c = commercial as Record<string, unknown>;
  if (typeof c.allowed !== "boolean") return ["commercial.allowed must be a boolean"];
  return [];
}

function validateFees(fees: unknown): string[] {
  if (fees === undefined) return [];
  if (!Array.isArray(fees)) return ["fees must be an array"];
  return [];
}

function validateV1_1(manifest: Record<string, unknown>): string[] {
  return [
    ...validateRequiredFieldsV1_1(manifest),
    ...validateAccess(manifest.access),
    ...validateDidShareList(manifest.attribution, "attribution"),
    ...validateTransferV1_1(manifest.transfer),
    ...validateDistributionV1_1(manifest.distribution),
    ...validateTraining(manifest.training),
    ...validateCommercial(manifest.commercial),
    ...validateSettlement(manifest.settlement),
    ...validateFees(manifest.fees),
  ];
}

// ---------------------------------------------------------------------------
// V1.0 section validators
// ---------------------------------------------------------------------------

function validateRequiredFieldsV1_0(m: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof m.fair !== "string" || !m.fair) errors.push("fair (version) is required");
  if (typeof m.id !== "string" || !m.id) errors.push("id is required");
  if (typeof m.type !== "string" || !m.type) errors.push("type is required");
  if (typeof m.owner !== "string" || !m.owner) errors.push("owner (DID) is required");
  if (typeof m.created !== "string" || !m.created) errors.push("created (ISO 8601) is required");
  return errors;
}

function validateAttributionEntryV1_0(entry: Record<string, unknown>, i: number): { errors: string[]; share: number } {
  const errors: string[] = [];
  if (typeof entry.did !== "string" || !entry.did) errors.push(`attribution[${i}].did must be a non-empty string`);
  if (typeof entry.role !== "string" || !entry.role) errors.push(`attribution[${i}].role must be a non-empty string`);
  const shareValid = typeof entry.share === "number" && entry.share >= 0 && entry.share <= 1;
  if (!shareValid) errors.push(`attribution[${i}].share must be a number between 0 and 1`);
  return { errors, share: shareValid ? (entry.share as number) : 0 };
}

function validateAttributionV1_0(attribution: unknown): string[] {
  if (!Array.isArray(attribution)) return ["attribution must be an array"];
  let shareSum = 0;
  const errors: string[] = [];
  for (let i = 0; i < attribution.length; i++) {
    const { errors: entryErrors, share } = validateAttributionEntryV1_0(attribution[i] as Record<string, unknown>, i);
    errors.push(...entryErrors);
    shareSum += share;
  }
  if (shareSum > 1.0001) errors.push(`attribution shares sum to ${shareSum.toFixed(4)}, must not exceed 1.0`);
  return errors;
}

function validateTransferV1_0(transfer: unknown): string[] {
  if (transfer === undefined) return [];
  const t = transfer as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof t.allowed !== "boolean") errors.push("transfer.allowed must be a boolean");
  if (t.resaleRoyalty !== undefined) {
    if (typeof t.resaleRoyalty !== "number" || t.resaleRoyalty < 0 || t.resaleRoyalty > 1) {
      errors.push("transfer.resaleRoyalty must be a number between 0 and 1");
    }
  }
  return errors;
}

function validateSignatureField(fieldName: string, sig: unknown): string[] {
  if (typeof sig !== "object" || sig === null) return [`${fieldName} must be an object`];
  const s = sig as Record<string, unknown>;
  const errors: string[] = [];
  if (s.algorithm !== "ed25519") errors.push(`${fieldName}.algorithm must be "ed25519"`);
  if (typeof s.value !== "string" || !/^[0-9a-f]{128}$/.test(s.value)) {
    errors.push(`${fieldName}.value must be a 128 hex character string`);
  }
  if (typeof s.publicKeyRef !== "string" || !s.publicKeyRef.startsWith("did:")) {
    errors.push(`${fieldName}.publicKeyRef must start with "did:"`);
  }
  return errors;
}

function validateSignaturesV1_0(m: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of ["signature", "platformSignature"] as const) {
    if (m[field] !== undefined) errors.push(...validateSignatureField(field, m[field]));
  }
  return errors;
}

function validateIntentV1_0(intent: unknown): string[] {
  if (intent === undefined) return [];
  const i = intent as Record<string, unknown>;
  if (typeof i.purpose !== "string" || !i.purpose) return ["intent.purpose must be a non-empty string"];
  return [];
}

function validateV1_0(manifest: Record<string, unknown>): string[] {
  return [
    ...validateRequiredFieldsV1_0(manifest),
    ...validateAccess(manifest.access),
    ...validateAttributionV1_0(manifest.attribution),
    ...validateTransferV1_0(manifest.transfer),
    ...validateSignaturesV1_0(manifest),
    ...validateIntentV1_0(manifest.intent),
  ];
}

export function validateManifest(manifest: unknown): { ok: boolean; valid: boolean; errors: string[] } {
  if (typeof manifest !== "object" || manifest === null) {
    return { ok: false, valid: false, errors: ["manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;
  const isV1_1 = m.fair === "1.1" || m.version === "1.1";
  const errors = isV1_1 ? validateV1_1(m) : validateV1_0(m);
  const ok = errors.length === 0;
  return { ok, valid: ok, errors };
}

export function isValidManifest(manifest: unknown): manifest is FairManifest {
  return validateManifest(manifest).ok;
}
