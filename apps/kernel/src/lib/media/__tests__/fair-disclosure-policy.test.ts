/**
 * Unit tests for fair-disclosure-policy (#1440).
 *
 * This module is pure (no I/O), so tests run without any mocks.
 * Coverage targets:
 *   - Floor fields are always silent regardless of overlay settings
 *   - Silent fields pass through
 *   - on-consent fields are withheld without a grant / included with a grant
 *   - `never` fields are structurally dropped from both manifest and _withheld
 *   - Attribution sub-field gating (name/note withheld; did/share pass)
 *   - Nested amount scrubbing in distribution and transfer
 *   - Community overlay overrides the default
 *   - Subject gates override the community overlay (tighten and loosen)
 *   - parseSubjectGates handles valid, missing, and malformed _disclosure
 *   - _disclosure is never emitted in the output
 */

import { describe, it, expect } from "vitest";
import {
  FAIR_FLOOR_FIELDS,
  DEFAULT_AGRIFORTRESS_OVERLAY,
  composeEffectivePolicy,
  applyDisclosureGates,
  parseSubjectGates,
  type FairDisclosureOverlay,
} from "../fair-disclosure-policy";
import type { FairManifestV1_1 } from "@imajin/fair";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal v1.1 manifest with all field groups represented. */
const BASE_MANIFEST: FairManifestV1_1 = {
  fair: "1.1",
  version: "1.1",
  id: "fair_test_001",
  type: "settlement",
  owner: "did:imajin:owner",
  created: "2026-01-01T00:00:00Z",
  access: { type: "public" },
  attribution: [
    { did: "did:imajin:alice", role: "creator", share: 70, name: "Alice Example", note: "lead" },
    { did: "did:imajin:bob", role: "producer", share: 30 },
  ],
  fees: [
    { role: "platform", name: "Platform fee", rateBps: 250, fixedCents: 0 },
  ],
  integrity: { hash: "abc123", size: 512 },
  signature: { signer: "did:imajin:node", alg: "ed25519", value: "sig", signedAt: "2026-01-01T00:00:00Z" },
  distribution: {
    reproduction: { mode: "license", price: { amount: 5000, currency: "MJNX" } },
  },
  transfer: {
    allowed: true,
    price: { amount: 9900, currency: "USD" },
  },
  training: { allowed: false },
  commercial: { allowed: true },
  tipping: { enabled: true },
};

// ── FAIR_FLOOR_FIELDS ────────────────────────────────────────────────────────

describe("FAIR_FLOOR_FIELDS", () => {
  it("contains the minimum public record fields", () => {
    const required = ["id", "type", "created", "fair", "version", "integrity", "signature", "platformSignature"];
    for (const f of required) {
      expect(FAIR_FLOOR_FIELDS.has(f as never)).toBe(true);
    }
  });
});

// ── composeEffectivePolicy ────────────────────────────────────────────────────

describe("composeEffectivePolicy", () => {
  it("pins floor fields to silent regardless of community overlay", () => {
    const overlay: FairDisclosureOverlay = {
      id: { release: "never" },         // attempt to suppress a floor field
      integrity: { release: "on-consent" },
    };
    const policy = composeEffectivePolicy(overlay);
    expect(policy["id"]?.release).toBe("silent");
    expect(policy["id"]?.isFloor).toBe(true);
    expect(policy["integrity"]?.release).toBe("silent");
    expect(policy["integrity"]?.isFloor).toBe(true);
  });

  it("applies community overlay defaults for non-floor fields", () => {
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY);
    expect(policy["fees"]?.release).toBe("silent");
    expect(policy["amount"]?.release).toBe("on-consent");
    expect(policy["attribution[*].name"]?.release).toBe("on-consent");
  });

  it("lets subject gates tighten community defaults", () => {
    // Community: fees = silent; subject wants fees = on-consent
    const subject: FairDisclosureOverlay = { fees: { release: "on-consent" } };
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY, subject);
    expect(policy["fees"]?.release).toBe("on-consent");
  });

  it("lets subject gates loosen community defaults (radical transparency)", () => {
    // Community: amount = on-consent; subject wants to make it public
    const subject: FairDisclosureOverlay = { amount: { release: "silent" } };
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY, subject);
    expect(policy["amount"]?.release).toBe("silent");
  });

  it("subject cannot loosen a floor field", () => {
    // Floor fields are pinned regardless of subject attempt to hide them
    const subject: FairDisclosureOverlay = { id: { release: "never" } };
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY, subject);
    expect(policy["id"]?.release).toBe("silent");
    expect(policy["id"]?.isFloor).toBe(true);
  });

  it("unknown fields not in overlay default to silent", () => {
    const policy = composeEffectivePolicy({});
    // source is not in the empty overlay — should default to silent
    expect(policy["source"]?.release ?? "silent").toBe("silent");
  });
});

// ── applyDisclosureGates — floor fields always pass ──────────────────────────

describe("applyDisclosureGates — floor fields", () => {
  const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY);

  it("always includes id, type, created, fair, version", () => {
    const { manifest } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).toHaveProperty("id", "fair_test_001");
    expect(manifest).toHaveProperty("type", "settlement");
    expect(manifest).toHaveProperty("created", "2026-01-01T00:00:00Z");
    expect(manifest).toHaveProperty("fair", "1.1");
    expect(manifest).toHaveProperty("version", "1.1");
  });

  it("always includes integrity and signature", () => {
    const { manifest } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).toHaveProperty("integrity");
    expect(manifest).toHaveProperty("signature");
  });
});

// ── applyDisclosureGates — silent fields ─────────────────────────────────────

describe("applyDisclosureGates — silent fields", () => {
  const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY);

  it("includes silent fee rates", () => {
    const { manifest } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).toHaveProperty("fees");
    const fees = manifest["fees"] as Array<{ rateBps: number }>;
    expect(fees[0]?.rateBps).toBe(250);
  });

  it("includes training and commercial flags", () => {
    const { manifest } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).toHaveProperty("training");
    expect(manifest).toHaveProperty("commercial");
  });
});

// ── applyDisclosureGates — on-consent fields withheld ────────────────────────

describe("applyDisclosureGates — on-consent, no grant", () => {
  const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY);

  it("withholds distribution when on-consent and no grant", () => {
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).not.toHaveProperty("distribution");
    expect(withheld).toHaveProperty("distribution");
    expect(withheld["distribution"]).toEqual({ present: true, attestation: "covered-by-signature" });
  });

  it("withholds transfer when on-consent and no grant", () => {
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).not.toHaveProperty("transfer");
    expect(withheld).toHaveProperty("transfer");
  });

  it("strips attribution names and emits attestation", () => {
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    const attribution = manifest["attribution"] as Array<Record<string, unknown>>;
    // name should be stripped from both entries
    expect(attribution[0]).not.toHaveProperty("name");
    expect(attribution[1]).not.toHaveProperty("name");
    // note stripped from entry with note
    expect(attribution[0]).not.toHaveProperty("note");
    // attestation present
    expect(withheld).toHaveProperty("attribution[*].name");
    expect(withheld["attribution[*].name"]).toEqual({ present: true, attestation: "covered-by-signature" });
  });

  it("preserves attribution did, share, role alongside withheld name", () => {
    const { manifest } = applyDisclosureGates(BASE_MANIFEST, policy);
    const attribution = manifest["attribution"] as Array<Record<string, unknown>>;
    expect(attribution[0]).toHaveProperty("did", "did:imajin:alice");
    expect(attribution[0]).toHaveProperty("share", 70);
    expect(attribution[0]).toHaveProperty("role", "creator");
  });

  it("does not emit _withheld entry for null/absent on-consent fields", () => {
    // Manifest without distribution — withheld should not reference it
    const slim = { ...BASE_MANIFEST, distribution: undefined } as unknown as typeof BASE_MANIFEST;
    const { withheld } = applyDisclosureGates(slim, policy);
    expect(withheld).not.toHaveProperty("distribution");
  });
});

// ── applyDisclosureGates — on-consent field disclosed when granted ────────────

describe("applyDisclosureGates — on-consent, with grant", () => {
  const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY);

  it("includes distribution when grant covers it", () => {
    const granted = new Set(["distribution"]);
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy, granted);
    expect(manifest).toHaveProperty("distribution");
    expect(withheld).not.toHaveProperty("distribution");
  });

  it("still scrubs nested amount from granted distribution when amount is ungated", () => {
    // Grant covers `distribution` but not `amount` → price.amount scrubbed
    const granted = new Set(["distribution"]);
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy, granted);
    const dist = manifest["distribution"] as Record<string, { price?: unknown }>;
    expect(dist["reproduction"]).not.toHaveProperty("price");
    expect(withheld).toHaveProperty("amount");
  });

  it("includes distribution.price when both distribution and amount are granted", () => {
    const granted = new Set(["distribution", "amount"]);
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy, granted);
    const dist = manifest["distribution"] as Record<string, { price?: { amount: number } }>;
    expect(dist["reproduction"]?.price?.amount).toBe(5000);
    expect(withheld).not.toHaveProperty("amount");
  });

  it("includes attribution names when attribution[*].name is granted", () => {
    const granted = new Set(["attribution[*].name"]);
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy, granted);
    const attribution = manifest["attribution"] as Array<Record<string, unknown>>;
    expect(attribution[0]).toHaveProperty("name", "Alice Example");
    expect(withheld).not.toHaveProperty("attribution[*].name");
  });
});

// ── applyDisclosureGates — never fields ──────────────────────────────────────

describe("applyDisclosureGates — never fields", () => {
  it("structurally drops a `never` field from both manifest and withheld", () => {
    const overlay: FairDisclosureOverlay = {
      ...DEFAULT_AGRIFORTRESS_OVERLAY,
      fees: { release: "never" },
    };
    const policy = composeEffectivePolicy(overlay);
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).not.toHaveProperty("fees");
    expect(withheld).not.toHaveProperty("fees");
  });
});

// ── applyDisclosureGates — _disclosure not emitted ───────────────────────────

describe("applyDisclosureGates — _disclosure suppression", () => {
  it("never emits _disclosure in the output manifest", () => {
    const withGates = {
      ...BASE_MANIFEST,
      _disclosure: { amount: { release: "silent" } },
    } as unknown as typeof BASE_MANIFEST;
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY);
    const { manifest } = applyDisclosureGates(withGates, policy);
    expect(manifest).not.toHaveProperty("_disclosure");
  });
});

// ── Community overlay overrides ───────────────────────────────────────────────

describe("community overlay variations", () => {
  it("private supplier overlay — hides fees and amounts entirely", () => {
    const privateSupplierOverlay: FairDisclosureOverlay = {
      ...DEFAULT_AGRIFORTRESS_OVERLAY,
      fees: { release: "never" },
      amount: { release: "never" },
      distribution: { release: "never" },
      transfer: { release: "never" },
    };
    const policy = composeEffectivePolicy(privateSupplierOverlay);
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).not.toHaveProperty("fees");
    expect(manifest).not.toHaveProperty("distribution");
    expect(manifest).not.toHaveProperty("transfer");
    expect(withheld).not.toHaveProperty("fees");      // `never` = no attestation either
    expect(withheld).not.toHaveProperty("amount");
  });

  it("radical-transparency overlay — exposes amounts", () => {
    const radicalOverlay: FairDisclosureOverlay = {
      ...DEFAULT_AGRIFORTRESS_OVERLAY,
      amount: { release: "silent" },
      distribution: { release: "silent" },
      transfer: { release: "silent" },
      "attribution[*].name": { release: "silent" },
    };
    const policy = composeEffectivePolicy(radicalOverlay);
    const { manifest, withheld } = applyDisclosureGates(BASE_MANIFEST, policy);
    expect(manifest).toHaveProperty("distribution");
    expect(manifest).toHaveProperty("transfer");
    const dist = manifest["distribution"] as Record<string, { price?: { amount: number } }>;
    expect(dist["reproduction"]?.price?.amount).toBe(5000);
    const attribution = manifest["attribution"] as Array<Record<string, unknown>>;
    expect(attribution[0]).toHaveProperty("name", "Alice Example");
    expect(withheld).not.toHaveProperty("amount");
  });
});

// ── parseSubjectGates ─────────────────────────────────────────────────────────

describe("parseSubjectGates", () => {
  it("parses valid _disclosure field gates", () => {
    const raw = {
      _disclosure: {
        amount: { release: "silent" },
        "attribution[*].name": { release: "on-consent" },
        distribution: { release: "never" },
      },
    };
    const gates = parseSubjectGates(raw);
    expect(gates["amount"]).toEqual({ release: "silent" });
    expect(gates["attribution[*].name"]).toEqual({ release: "on-consent" });
    expect(gates["distribution"]).toEqual({ release: "never" });
  });

  it("returns empty overlay when _disclosure is absent", () => {
    expect(parseSubjectGates({ id: "x" })).toEqual({});
  });

  it("returns empty overlay when _disclosure is not an object", () => {
    expect(parseSubjectGates({ _disclosure: "invalid" })).toEqual({});
    expect(parseSubjectGates({ _disclosure: ["array"] })).toEqual({});
  });

  it("silently ignores entries with invalid release values", () => {
    const raw = {
      _disclosure: {
        amount: { release: "definitely-not-a-tier" },
        fees: { release: "silent" },
      },
    };
    const gates = parseSubjectGates(raw);
    expect(gates).not.toHaveProperty("amount");
    expect(gates["fees"]).toEqual({ release: "silent" });
  });

  it("silently ignores non-object entries", () => {
    const raw = {
      _disclosure: {
        amount: "silent",       // string, not object
        fees: { release: "silent" },
      },
    };
    const gates = parseSubjectGates(raw);
    expect(gates).not.toHaveProperty("amount");
    expect(gates["fees"]).toEqual({ release: "silent" });
  });
});

// ── Subject gates integration: compose + apply ───────────────────────────────

describe("subject gates integration", () => {
  it("subject loosens amount to silent → amount exposed without a grant", () => {
    const raw = {
      ...BASE_MANIFEST,
      _disclosure: {
        amount: { release: "silent" },
        distribution: { release: "silent" },
        transfer: { release: "silent" },
      },
    } as unknown as typeof BASE_MANIFEST;

    const subjectGates = parseSubjectGates(raw as unknown as Record<string, unknown>);
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY, subjectGates);
    const { manifest, withheld } = applyDisclosureGates(raw, policy);

    // distribution and transfer now pass
    expect(manifest).toHaveProperty("distribution");
    expect(manifest).toHaveProperty("transfer");
    // nested amount no longer withheld
    expect(withheld).not.toHaveProperty("amount");
  });

  it("subject tightens fees to on-consent → fees withheld without grant", () => {
    const raw = {
      ...BASE_MANIFEST,
      _disclosure: { fees: { release: "on-consent" } },
    } as unknown as typeof BASE_MANIFEST;

    const subjectGates = parseSubjectGates(raw as unknown as Record<string, unknown>);
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY, subjectGates);
    const { manifest, withheld } = applyDisclosureGates(raw, policy);

    expect(manifest).not.toHaveProperty("fees");
    expect(withheld).toHaveProperty("fees");
  });

  it("floor fields remain in the response even when subject _disclosure references them", () => {
    const raw = {
      ...BASE_MANIFEST,
      _disclosure: { id: { release: "never" } },
    } as unknown as typeof BASE_MANIFEST;

    const subjectGates = parseSubjectGates(raw as unknown as Record<string, unknown>);
    const policy = composeEffectivePolicy(DEFAULT_AGRIFORTRESS_OVERLAY, subjectGates);
    const { manifest } = applyDisclosureGates(raw, policy);

    expect(manifest).toHaveProperty("id", "fair_test_001");
  });
});
