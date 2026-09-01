import { describe, it, expect } from "vitest";
import {
  detectExternalSend,
  detectArtifactProduced,
  detectCommitmentAsserted,
  detectDirectionChanged,
  evaluateWarrantTriggers,
  createHeuristicWarrantGate,
} from "../src/reflex-warrant-gate.js";

describe("trigger detectors", () => {
  it("detects external-send hints", () => {
    expect(detectExternalSend("I posted this to the forum")).toBe(true);
    expect(detectExternalSend("just thinking out loud")).toBe(false);
  });

  it("detects artifact-produced hints", () => {
    expect(detectArtifactProduced("opened pull request #42")).toBe(true);
    expect(detectArtifactProduced("no artifacts here")).toBe(false);
  });

  it("detects commitment-asserted hints", () => {
    expect(detectCommitmentAsserted("this will ship by 2026-08-01")).toBe(true);
    expect(detectCommitmentAsserted("no promises made")).toBe(false);
  });

  it("detects direction-changed hints", () => {
    expect(detectDirectionChanged("on second thought, let's do it differently")).toBe(true);
    expect(detectDirectionChanged("staying the course")).toBe(false);
  });
});

describe("evaluateWarrantTriggers", () => {
  it("returns every trigger that matched", () => {
    const triggers = evaluateWarrantTriggers("I posted the pull request; it is done, instead of the old plan.");
    expect(triggers).toEqual(
      expect.arrayContaining(["external-send", "artifact-produced", "commitment-asserted", "direction-changed"]),
    );
  });

  it("returns an empty array for plain text", () => {
    expect(evaluateWarrantTriggers("just a normal sentence")).toEqual([]);
  });
});

describe("createHeuristicWarrantGate", () => {
  it("warrants a turn when a trigger is detected", () => {
    const gate = createHeuristicWarrantGate();
    const result = gate.evaluate({ finalAnswer: "I posted this update to the channel." });
    expect(result.warranted).toBe(true);
    expect(result.triggers).toContain("external-send");
  });

  it("does not warrant a turn with no detected triggers", () => {
    const gate = createHeuristicWarrantGate();
    const result = gate.evaluate({ finalAnswer: "Here is a plain answer with no special content." });
    expect(result.warranted).toBe(false);
    expect(result.triggers).toEqual([]);
  });

  it("does not warrant an empty final answer", () => {
    const gate = createHeuristicWarrantGate();
    const result = gate.evaluate({ finalAnswer: "" });
    expect(result.warranted).toBe(false);
  });
});
