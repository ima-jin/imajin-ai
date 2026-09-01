import { describe, it, expect, vi } from "vitest";
import { evaluateReflexTurn, createReflexFinalizeHandler } from "../src/reflex-finalize-hook.js";
import type { WarrantGate, InjectionChecker, ConcernFinding, ReflexLogEntry } from "../src/reflex-types.js";
import type { ReflexLogger } from "../src/reflex-log.js";

function gateReturning(warranted: boolean, triggers: string[] = []): WarrantGate {
  return { evaluate: () => ({ warranted, triggers: triggers as never }) };
}

function checkerReturning(findings: ConcernFinding[]): InjectionChecker {
  return { checkConcerns: async () => findings };
}

function fakeLogger(): ReflexLogger & { records: Omit<ReflexLogEntry, "ts">[] } {
  const records: Omit<ReflexLogEntry, "ts">[] = [];
  return {
    records,
    record: (entry) => {
      records.push(entry);
    },
  };
}

describe("evaluateReflexTurn", () => {
  it("does not call the injection checker when the warrant gate declines", async () => {
    const checkConcerns = vi.fn().mockResolvedValue([]);
    const result = await evaluateReflexTurn(
      { finalAnswer: "plain" },
      gateReturning(false),
      { checkConcerns },
    );
    expect(result.warranted).toBe(false);
    expect(checkConcerns).not.toHaveBeenCalled();
  });

  it("runs the injection check and reports no stamp when nothing trips", async () => {
    const result = await evaluateReflexTurn(
      { finalAnswer: "I posted this" },
      gateReturning(true, ["external-send"]),
      checkerReturning([{ concern: "honesty", tripped: false }]),
    );
    expect(result.warranted).toBe(true);
    expect(result.trippedFindings).toEqual([]);
    expect(result.stamp).toBeUndefined();
  });

  it("builds a stamp when a concern trips", async () => {
    const result = await evaluateReflexTurn(
      { finalAnswer: "I posted this" },
      gateReturning(true, ["external-send"]),
      checkerReturning([{ concern: "overclaim", tripped: true }]),
    );
    expect(result.stamp).toBe("<beta> overclaim [👍/👎]");
    expect(result.trippedFindings).toEqual([{ concern: "overclaim", tripped: true }]);
  });
});

describe("createReflexFinalizeHandler", () => {
  it("returns undefined (ships inert) when reflex.enabled is not explicitly true", () => {
    expect(createReflexFinalizeHandler(undefined)).toBeUndefined();
    expect(createReflexFinalizeHandler({})).toBeUndefined();
    expect(createReflexFinalizeHandler({ enabled: false })).toBeUndefined();
  });

  it("finalizes as-is and does not log when the warrant gate declines", async () => {
    const logger = fakeLogger();
    const handler = createReflexFinalizeHandler(
      { enabled: true },
      { warrantGate: gateReturning(false), logger },
    );
    expect(handler).toBeDefined();
    const result = await handler!({ finalAnswer: "plain answer", sessionKey: "s1" });
    expect(result).toEqual({ action: "finalize" });
    expect(logger.records).toEqual([]);
  });

  it("finalizes as-is but logs a warranted, all-clear turn", async () => {
    const logger = fakeLogger();
    const handler = createReflexFinalizeHandler(
      { enabled: true },
      {
        warrantGate: gateReturning(true, ["external-send"]),
        injectionChecker: checkerReturning([{ concern: "honesty", tripped: false }]),
        logger,
      },
    );
    const result = await handler!({ finalAnswer: "I posted this", sessionKey: "s1", runId: "r1" });
    expect(result).toEqual({ action: "finalize" });
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]).toMatchObject({ warranted: true, sessionKey: "s1", runId: "r1", stamp: undefined });
  });

  it("requests a revise pass with the stamp instruction when a concern trips", async () => {
    const logger = fakeLogger();
    const handler = createReflexFinalizeHandler(
      { enabled: true },
      {
        warrantGate: gateReturning(true, ["commitment-asserted"]),
        injectionChecker: checkerReturning([{ concern: "overclaim", tripped: true, rationale: "unverified claim" }]),
        logger,
      },
    );
    const result = await handler!({ finalAnswer: "It is done.", sessionKey: "s2" });
    expect(result.action).toBe("revise");
    expect(result.retry?.instruction).toContain("<beta> overclaim: unverified claim [👍/👎]");
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0].stamp).toBe("<beta> overclaim: unverified claim [👍/👎]");
  });

  it("fails open (finalize) when the pipeline throws", async () => {
    const throwingGate: WarrantGate = {
      evaluate: () => {
        throw new Error("boom");
      },
    };
    const handler = createReflexFinalizeHandler({ enabled: true }, { warrantGate: throwingGate });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await handler!({ finalAnswer: "anything" });
    expect(result).toEqual({ action: "finalize" });
    errorSpy.mockRestore();
  });

  it("uses the stub injection checker by default, so an enabled-but-unconfigured hook never revises", async () => {
    const logger = fakeLogger();
    const handler = createReflexFinalizeHandler(
      { enabled: true },
      { warrantGate: gateReturning(true, ["external-send"]), logger },
    );
    const result = await handler!({ finalAnswer: "I posted this" });
    expect(result).toEqual({ action: "finalize" });
  });
});
