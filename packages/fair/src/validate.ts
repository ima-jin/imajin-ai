import type { FairManifest } from "./types";

export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  if (typeof m.fair !== "string" || !m.fair) errors.push("fair (version) is required");
  if (typeof m.id !== "string" || !m.id) errors.push("id is required");
  if (typeof m.type !== "string" || !m.type) errors.push("type is required");
  if (typeof m.owner !== "string" || !m.owner) errors.push("owner (DID) is required");
  if (typeof m.created !== "string" || !m.created) errors.push("created (ISO 8601) is required");

  // Access validation
  if (m.access === undefined || m.access === null) {
    errors.push("access is required");
  } else if (typeof m.access === "string") {
    if (m.access !== "public" && m.access !== "private") {
      errors.push('access string must be "public" or "private"');
    }
  } else if (typeof m.access === "object") {
    const access = m.access as Record<string, unknown>;
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
      if (!Array.isArray(access.allowedDids)) {
        errors.push("access.allowedDids must be an array");
      } else {
        for (const did of access.allowedDids) {
          if (typeof did !== "string" || !did) errors.push("each allowedDid must be a non-empty string");
        }
      }
    }
  } else {
    errors.push("access must be a string or object");
  }

  // Attribution validation
  if (!Array.isArray(m.attribution)) {
    errors.push("attribution must be an array");
  } else {
    let shareSum = 0;
    for (let i = 0; i < m.attribution.length; i++) {
      const entry = m.attribution[i] as Record<string, unknown>;
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
  }

  // Transfer validation (optional)
  if (m.transfer !== undefined) {
    const t = m.transfer as Record<string, unknown>;
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
    if (m[field] !== undefined) {
      const sig = m[field] as Record<string, unknown>;
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
  if (m.intent !== undefined) {
    const intent = m.intent as Record<string, unknown>;
    if (typeof intent.purpose !== "string" || !intent.purpose) {
      errors.push("intent.purpose must be a non-empty string");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isValidManifest(manifest: unknown): manifest is FairManifest {
  return validateManifest(manifest).valid;
}
