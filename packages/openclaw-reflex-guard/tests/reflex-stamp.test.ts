import { describe, it, expect } from "vitest";
import { buildBetaStamp, selectStampedFindings, MAX_STAMPED_CONCERNS } from "../src/reflex-stamp.js";
import type { ConcernFinding } from "../src/reflex-types.js";

describe("selectStampedFindings", () => {
  it("filters out findings that did not trip", () => {
    const findings: ConcernFinding[] = [
      { concern: "honesty", tripped: false },
      { concern: "overclaim", tripped: true },
    ];
    expect(selectStampedFindings(findings)).toEqual([{ concern: "overclaim", tripped: true }]);
  });

  it(`caps at ${MAX_STAMPED_CONCERNS} tripped findings`, () => {
    const findings: ConcernFinding[] = [
      { concern: "honesty", tripped: true },
      { concern: "overclaim", tripped: true },
      { concern: "voice", tripped: true },
    ];
    expect(selectStampedFindings(findings)).toHaveLength(MAX_STAMPED_CONCERNS);
  });
});

describe("buildBetaStamp", () => {
  it("returns undefined when nothing tripped", () => {
    expect(buildBetaStamp([{ concern: "honesty", tripped: false }])).toBeUndefined();
    expect(buildBetaStamp([])).toBeUndefined();
  });

  it("builds a <beta> stamp with the concern name for a single trip with no rationale", () => {
    const stamp = buildBetaStamp([{ concern: "overclaim", tripped: true }]);
    expect(stamp).toBe("<beta> overclaim [👍/👎]");
  });

  it("includes the rationale when present", () => {
    const stamp = buildBetaStamp([{ concern: "voice", tripped: true, rationale: "sounded too formal" }]);
    expect(stamp).toBe("<beta> voice: sounded too formal [👍/👎]");
  });

  it("joins multiple tripped concerns and caps at 2", () => {
    const stamp = buildBetaStamp([
      { concern: "honesty", tripped: true },
      { concern: "overclaim", tripped: true },
      { concern: "voice", tripped: true },
    ]);
    expect(stamp).toBe("<beta> honesty; overclaim [👍/👎]");
  });
});
