import { describe, it, expect } from "vitest";
import { createStubInjectionChecker } from "../src/reflex-injection-check.js";

describe("createStubInjectionChecker", () => {
  it("always resolves with no tripped concerns", async () => {
    const checker = createStubInjectionChecker();
    const findings = await checker.checkConcerns({ finalAnswer: "anything" }, ["external-send"]);
    expect(findings).toEqual([]);
  });

  it("ignores the trigger list without throwing", async () => {
    const checker = createStubInjectionChecker();
    await expect(
      checker.checkConcerns({ finalAnswer: "x" }, ["external-send", "artifact-produced", "commitment-asserted", "direction-changed"]),
    ).resolves.toEqual([]);
  });
});
