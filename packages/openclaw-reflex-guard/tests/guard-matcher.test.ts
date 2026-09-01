import { describe, it, expect } from "vitest";
import { scanForSealedTerms, resolveScanAction, scanOutboundContent } from "../src/guard-matcher.js";
import type { CompiledSealedTerm } from "../src/guard-config.js";

function term(id: string, action: "block" | "flag", needle: string): CompiledSealedTerm {
  return { id, action, test: (content) => content.includes(needle) };
}

describe("scanForSealedTerms", () => {
  it("returns no matches for content with no hits", () => {
    const matches = scanForSealedTerms("hello world", [term("a", "block", "xyz")]);
    expect(matches).toEqual([]);
  });

  it("returns a match for a single hit", () => {
    const matches = scanForSealedTerms("hello secret world", [term("a", "block", "secret")]);
    expect(matches).toEqual([{ termId: "a", action: "block" }]);
  });

  it("returns every matching term when multiple terms hit (multi-term)", () => {
    const terms = [term("a", "block", "secret"), term("b", "flag", "world"), term("c", "block", "nope")];
    const matches = scanForSealedTerms("hello secret world", terms);
    expect(matches).toEqual([
      { termId: "a", action: "block" },
      { termId: "b", action: "flag" },
    ]);
  });

  it("returns an empty array for empty content", () => {
    expect(scanForSealedTerms("", [term("a", "block", "x")])).toEqual([]);
  });

  it("does not crash the scan when one term's matcher throws", () => {
    const throwing: CompiledSealedTerm = {
      id: "boom",
      action: "block",
      test: () => {
        throw new Error("boom");
      },
    };
    const matches = scanForSealedTerms("hello secret", [throwing, term("a", "block", "secret")]);
    expect(matches).toEqual([{ termId: "a", action: "block" }]);
  });
});

describe("resolveScanAction", () => {
  it("returns \"none\" for no matches", () => {
    expect(resolveScanAction([])).toBe("none");
  });

  it("returns \"flag\" when only flag-action terms matched", () => {
    expect(resolveScanAction([{ termId: "a", action: "flag" }])).toBe("flag");
  });

  it("returns \"block\" when only block-action terms matched", () => {
    expect(resolveScanAction([{ termId: "a", action: "block" }])).toBe("block");
  });

  it("returns \"block\" when both block and flag terms matched (block wins)", () => {
    expect(
      resolveScanAction([
        { termId: "a", action: "flag" },
        { termId: "b", action: "block" },
      ]),
    ).toBe("block");
  });
});

describe("scanOutboundContent", () => {
  it("combines matches and the resolved action for a block-mode hit", () => {
    const result = scanOutboundContent("contains secret", [term("a", "block", "secret")]);
    expect(result.action).toBe("block");
    expect(result.matches).toEqual([{ termId: "a", action: "block" }]);
  });

  it("combines matches and the resolved action for a flag-mode hit", () => {
    const result = scanOutboundContent("contains flaggable", [term("a", "flag", "flaggable")]);
    expect(result.action).toBe("flag");
  });

  it("returns action \"none\" for clean content", () => {
    const result = scanOutboundContent("nothing to see here", [term("a", "block", "secret")]);
    expect(result.action).toBe("none");
    expect(result.matches).toEqual([]);
  });
});
