import { describe, it, expect, vi } from "vitest";
import { compileTerm, resolveOutboundGuardConfig, DEFAULT_AUDIT_LOG_PATH } from "../src/guard-config.js";
import type { SealedTermConfig } from "../src/guard-config.js";

describe("compileTerm", () => {
  it("compiles a literal term with a case-insensitive substring matcher", () => {
    const outcome = compileTerm({ id: "t1", pattern: "Hello", action: "block" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.term.id).toBe("t1");
      expect(outcome.term.action).toBe("block");
      expect(outcome.term.test("say hello world")).toBe(true);
      expect(outcome.term.test("SAY HELLO WORLD")).toBe(true);
      expect(outcome.term.test("goodbye world")).toBe(false);
    }
  });

  it("compiles a regex term with the given flags", () => {
    const outcome = compileTerm({ id: "t2", pattern: "foo-\\d+", type: "regex", flags: "i", action: "flag" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.term.test("FOO-123")).toBe(true);
      expect(outcome.term.test("bar-123")).toBe(false);
    }
  });

  it("defaults regex flags to case-insensitive", () => {
    const outcome = compileTerm({ id: "t3", pattern: "^abc$", type: "regex", action: "block" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.term.test("ABC")).toBe(true);
    }
  });

  it("rejects a missing id", () => {
    const outcome = compileTerm({ pattern: "x", action: "block" } as unknown as SealedTermConfig);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/id/);
  });

  it("rejects an empty pattern", () => {
    const outcome = compileTerm({ id: "t4", pattern: "", action: "block" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.id).toBe("t4");
      expect(outcome.reason).toMatch(/pattern/);
    }
  });

  it("rejects an invalid action", () => {
    const outcome = compileTerm({ id: "t5", pattern: "x", action: "deny" as unknown as "block" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/action/);
  });

  it("rejects an invalid regex rather than throwing", () => {
    const outcome = compileTerm({ id: "t6", pattern: "(unterminated", type: "regex", action: "block" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.id).toBe("t6");
      expect(outcome.reason).toMatch(/invalid regex/);
    }
  });
});

describe("resolveOutboundGuardConfig", () => {
  it("defaults enabled to true and auditLogPath to the default path when omitted", () => {
    const resolved = resolveOutboundGuardConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.terms).toEqual([]);
    expect(resolved.auditLogPath).toBe(DEFAULT_AUDIT_LOG_PATH);
    expect(resolved.invalidTermIds).toEqual([]);
  });

  it("respects an explicit enabled: false", () => {
    const resolved = resolveOutboundGuardConfig({ enabled: false, terms: [{ id: "a", pattern: "x", action: "block" }] });
    expect(resolved.enabled).toBe(false);
  });

  it("compiles every valid term and preserves order", () => {
    const resolved = resolveOutboundGuardConfig({
      terms: [
        { id: "a", pattern: "aaa", action: "block" },
        { id: "b", pattern: "bbb", action: "flag" },
      ],
    });
    expect(resolved.terms.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("drops a malformed term, warns loudly, and keeps the rest of the list working", () => {
    const warn = vi.fn();
    const resolved = resolveOutboundGuardConfig(
      {
        terms: [
          { id: "good", pattern: "good-term", action: "block" },
          { id: "bad", pattern: "(unterminated", type: "regex", action: "block" },
        ],
      },
      { warn },
    );
    expect(resolved.terms.map((t) => t.id)).toEqual(["good"]);
    expect(resolved.invalidTermIds).toEqual(["bad"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/bad/);
  });

  it("uses a custom auditLogPath when provided", () => {
    const resolved = resolveOutboundGuardConfig({ auditLogPath: "custom/path.jsonl" });
    expect(resolved.auditLogPath).toBe("custom/path.jsonl");
  });

  it("falls back to the default auditLogPath for a blank string", () => {
    const resolved = resolveOutboundGuardConfig({ auditLogPath: "   " });
    expect(resolved.auditLogPath).toBe(DEFAULT_AUDIT_LOG_PATH);
  });
});
