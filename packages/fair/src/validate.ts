import type { FairManifest } from "./types";

const SUM_TOLERANCE = 1e-6;

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

function validateV1_1(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Required fields
  if (manifest.fair !== "1.1") errors.push("fair must be \"1.1\"");
  if (typeof manifest.id !== "string" || !manifest.id) errors.push("id is required");
  if (typeof manifest.type !== "string" || !manifest.type) errors.push("type is required");
  if (typeof manifest.owner !== "string" || !manifest.owner) errors.push("owner (DID) is required");
  if (typeof manifest.created !== "string" || !manifest.created) errors.push("created (ISO 8601) is required");

  // Access validation
  if (manifest.access === undefined || manifest.access === null) {
    errors.push("access is required");
  } else if (typeof manifest.access === "string") {
    if (manifest.access !== "public" && manifest.access !== "private") {
      errors.push('access string must be "public" or "private"');
    }
  } else if (typeof manifest.access === "object") {
    const access = manifest.access as Record<string, unknown>;
    const validTypes = ["public", "private", "trust-graph", "conversation"];
    if (!validTypes.includes(access.type as string)) {
      errors.push('access.type must be "public", "private", "trust-graph", or "conversation"');
    }
    if (access.type === "conversation") {
      if (typeof access.conversationDid !== "string" || !access.conversationDid) {
        errors.push('access.conversationDid must be a non-empty string when access.type is "conversation"');
      }
    }
    if (access.allowedDids !== undefined) {
      if (Array.isArray(access.allowedDids)) {
        for (const did of access.allowedDids) {
          if (typeof did !== "string" || !did) errors.push("each allowedDid must be a non-empty string");
        }
      } else {
        errors.push("access.allowedDids must be an array");
      }
    }
  } else {
    errors.push("access must be a string or object");
  }

  // Attribution
  errors.push(...validateDidShareList(manifest.attribution, "attribution"));

  // Transfer
  if (manifest.transfer !== undefined) {
    const t = manifest.transfer as Record<string, unknown>;
    if (typeof t.allowed !== "boolean") {
      errors.push("transfer.allowed must be a boolean");
    }
    if (t.price !== undefined) {
      errors.push(...validateMoney(t.price, "transfer.price"));
    }
    if (t.resaleRoyaltyBps !== undefined) {
      if (typeof t.resaleRoyaltyBps !== "number" || t.resaleRoyaltyBps < 0 || t.resaleRoyaltyBps > 10000) {
        errors.push("transfer.resaleRoyaltyBps must be a number between 0 and 10000");
      }
    }
  }

  // Distribution
  if (manifest.distribution !== undefined) {
    const d = manifest.distribution as Record<string, unknown>;
    for (const key of ["reproduction", "streaming", "derivative", "syndication"] as const) {
      if (d[key] !== undefined) {
        errors.push(...validateDistributionRight(d[key], `distribution.${key}`));
      }
    }
  }

  // Training
  if (manifest.training !== undefined) {
    const training = manifest.training as Record<string, unknown>;
    if (typeof training.allowed !== "boolean") {
      errors.push("training.allowed must be explicitly boolean");
    }
  }

  // Commercial
  if (manifest.commercial !== undefined) {
    const commercial = manifest.commercial as Record<string, unknown>;
    if (typeof commercial.allowed !== "boolean") {
      errors.push("commercial.allowed must be a boolean");
    }
  }

  // Settlement (optional)
  if (manifest.settlement !== undefined) {
    const settlement = manifest.settlement as Record<string, unknown>;
    if (typeof settlement !== "object" || settlement === null) {
      errors.push("settlement must be an object");
    } else {
      if (settlement.endpoint !== undefined && typeof settlement.endpoint !== "string") {
        errors.push("settlement.endpoint must be a string when present");
      }
      if (settlement.schemes !== undefined) {
        if (Array.isArray(settlement.schemes)) {
          const validSchemes = new Set(["x402", "stripe-link", "mjnx-direct", "solana-pay", "lightning"]);
          for (const s of settlement.schemes) {
            if (typeof s !== "string" || !validSchemes.has(s)) {
              errors.push(`settlement.schemes contains invalid scheme: ${s}`);
            }
          }
        } else {
          errors.push("settlement.schemes must be an array when present");
        }
      }
      if (settlement.fallback !== undefined) {
        const validSchemes = new Set(["x402", "stripe-link", "mjnx-direct", "solana-pay", "lightning"]);
        if (typeof settlement.fallback !== "string" || !validSchemes.has(settlement.fallback)) {
          errors.push("settlement.fallback must be a valid settlement scheme");
        }
      }
    }
  }

  // Fees (optional)
  if (manifest.fees !== undefined) {
    if (!Array.isArray(manifest.fees)) {
      errors.push("fees must be an array");
    }
  }

  return errors;
}

function validateV1_0(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Required fields
  if (typeof manifest.fair !== "string" || !manifest.fair) errors.push("fair (version) is required");
  if (typeof manifest.id !== "string" || !manifest.id) errors.push("id is required");
  if (typeof manifest.type !== "string" || !manifest.type) errors.push("type is required");
  if (typeof manifest.owner !== "string" || !manifest.owner) errors.push("owner (DID) is required");
  if (typeof manifest.created !== "string" || !manifest.created) errors.push("created (ISO 8601) is required");

  // Access validation
  if (manifest.access === undefined || manifest.access === null) {
    errors.push("access is required");
  } else if (typeof manifest.access === "string") {
    if (manifest.access !== "public" && manifest.access !== "private") {
      errors.push('access string must be "public" or "private"');
    }
  } else if (typeof manifest.access === "object") {
    const access = manifest.access as Record<string, unknown>;
    const validTypes = ["public", "private", "trust-graph", "conversation"];
    if (!validTypes.includes(access.type as string)) {
      errors.push('access.type must be "public", "private", "trust-graph", or "conversation"');
    }
    if (access.type === "conversation") {
      if (typeof access.conversationDid !== "string" || !access.conversationDid) {
        errors.push('access.conversationDid must be a non-empty string when access.type is "conversation"');
      }
    }
    if (access.allowedDids !== undefined) {
      if (Array.isArray(access.allowedDids)) {
        for (const did of access.allowedDids) {
          if (typeof did !== "string" || !did) errors.push("each allowedDid must be a non-empty string");
        }
      } else {
        errors.push("access.allowedDids must be an array");
      }
    }
  } else {
    errors.push("access must be a string or object");
  }

  // Attribution validation
  if (Array.isArray(manifest.attribution)) {
    let shareSum = 0;
    for (let i = 0; i < manifest.attribution.length; i++) {
      const entry = manifest.attribution[i] as Record<string, unknown>;
      if (typeof entry.did !== "string" || !entry.did) {
        errors.push(`attribution[${i}].did must be a non-empty string`);
      }
      if (typeof entry.role !== "string" || !entry.role) {
        errors.push(`attribution[${i}].role must be a non-empty string`);
      }
      if (typeof entry.share !== "number" || entry.share < 0 || entry.share > 1) {
        errors.push(`attribution[${i}].share must be a number between 0 and 1`);
      } else {
        shareSum += entry.share;
      }
    }
    if (shareSum > 1.0001) {
      errors.push(`attribution shares sum to ${shareSum.toFixed(4)}, must not exceed 1.0`);
    }
  } else {
    errors.push("attribution must be an array");
  }

  // Transfer validation (optional)
  if (manifest.transfer !== undefined) {
    const t = manifest.transfer as Record<string, unknown>;
    if (typeof t.allowed !== "boolean") {
      errors.push("transfer.allowed must be a boolean");
    }
    if (t.resaleRoyalty !== undefined) {
      if (typeof t.resaleRoyalty !== "number" || t.resaleRoyalty < 0 || t.resaleRoyalty > 1) {
        errors.push("transfer.resaleRoyalty must be a number between 0 and 1");
      }
    }
  }

  // Signature validation (Phase 1 — validate structure when present)
  for (const field of ["signature", "platformSignature"] as const) {
    if (manifest[field] !== undefined) {
      const sig = manifest[field] as Record<string, unknown>;
      if (typeof sig !== "object" || sig === null) {
        errors.push(`${field} must be an object`);
      } else {
        if (sig.algorithm !== "ed25519") {
          errors.push(`${field}.algorithm must be "ed25519"`);
        }
        if (typeof sig.value !== "string" || !/^[0-9a-f]{128}$/.test(sig.value)) {
          errors.push(`${field}.value must be a 128 hex character string`);
        }
        if (typeof sig.publicKeyRef !== "string" || !sig.publicKeyRef.startsWith("did:")) {
          errors.push(`${field}.publicKeyRef must start with "did:"`);
        }
      }
    }
  }

  // Intent validation (optional)
  if (manifest.intent !== undefined) {
    const intent = manifest.intent as Record<string, unknown>;
    if (typeof intent.purpose !== "string" || !intent.purpose) {
      errors.push("intent.purpose must be a non-empty string");
    }
  }

  return errors;
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
