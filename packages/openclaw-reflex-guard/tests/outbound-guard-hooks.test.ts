import { describe, it, expect, vi } from "vitest";
import { createMessageSendingHandler, createBeforeDispatchHandler } from "../src/outbound-guard-hooks.js";
import { resolveOutboundGuardConfig } from "../src/guard-config.js";
import type { AuditLogger } from "../src/audit-log.js";

function fakeAuditLogger(): AuditLogger & { records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    record(entry) {
      records.push(entry);
    },
  };
}

describe("createMessageSendingHandler", () => {
  it("passes through content with no match", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "t", pattern: "secret", action: "block" }] });
    const logger = fakeAuditLogger();
    const handler = createMessageSendingHandler(resolved, logger);
    const result = handler({ to: "user", content: "nothing sensitive here" });
    expect(result).toBeUndefined();
    expect(logger.records).toEqual([]);
  });

  it("cancels delivery on a block-action match and audit-logs the trip", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "patent-seal", pattern: "sealed-phrase", action: "block" }] });
    const logger = fakeAuditLogger();
    const handler = createMessageSendingHandler(resolved, logger);
    const result = handler({ to: "user", content: "leaking the sealed-phrase here" }, { sessionKey: "sess-1" });
    expect(result).toEqual({ cancel: true, cancelReason: expect.any(String) });
    expect(logger.records).toEqual([
      { termId: "patent-seal", surface: "message_sending", action: "block", sessionKey: "sess-1" },
    ]);
  });

  it("does not cancel on a flag-only match, but still audit-logs it", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "watch", pattern: "watchword", action: "flag" }] });
    const logger = fakeAuditLogger();
    const handler = createMessageSendingHandler(resolved, logger);
    const result = handler({ to: "user", content: "contains watchword" });
    expect(result).toBeUndefined();
    expect(logger.records).toEqual([{ termId: "watch", surface: "message_sending", action: "flag", sessionKey: undefined }]);
  });

  it("audit-logs every term that trips on a multi-term match, blocking if any is block-mode", () => {
    const resolved = resolveOutboundGuardConfig({
      terms: [
        { id: "flagme", pattern: "flagme", action: "flag" },
        { id: "blockme", pattern: "blockme", action: "block" },
      ],
    });
    const logger = fakeAuditLogger();
    const handler = createMessageSendingHandler(resolved, logger);
    const result = handler({ to: "user", content: "flagme and blockme both" });
    expect(result).toEqual({ cancel: true, cancelReason: expect.any(String) });
    expect(logger.records).toHaveLength(2);
  });

  it("is a no-op when the guard is disabled", () => {
    const resolved = resolveOutboundGuardConfig({ enabled: false, terms: [{ id: "t", pattern: "secret", action: "block" }] });
    const logger = fakeAuditLogger();
    const handler = createMessageSendingHandler(resolved, logger);
    const result = handler({ to: "user", content: "contains secret" });
    expect(result).toBeUndefined();
    expect(logger.records).toEqual([]);
  });

  it("is a no-op when there are no terms configured", () => {
    const resolved = resolveOutboundGuardConfig(undefined);
    const logger = fakeAuditLogger();
    const handler = createMessageSendingHandler(resolved, logger);
    const result = handler({ to: "user", content: "anything at all" });
    expect(result).toBeUndefined();
  });

  it("fails closed (cancels) when the handler itself errors", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "t", pattern: "secret", action: "block" }] });
    const logger: AuditLogger = {
      record: () => {
        throw new Error("logger exploded");
      },
    };
    const handler = createMessageSendingHandler(resolved, logger);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = handler({ to: "user", content: "contains secret" });
    expect(result).toEqual({ cancel: true, cancelReason: expect.stringContaining("failing closed") });
    errorSpy.mockRestore();
  });
});

describe("createBeforeDispatchHandler", () => {
  it("passes through content with no match", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "t", pattern: "secret", action: "block" }] });
    const logger = fakeAuditLogger();
    const handler = createBeforeDispatchHandler(resolved, logger);
    const result = handler({ content: "clean content" });
    expect(result).toBeUndefined();
  });

  it("blocks dispatch with a safe reply on a block-action match", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "t", pattern: "secret", action: "block" }] });
    const logger = fakeAuditLogger();
    const handler = createBeforeDispatchHandler(resolved, logger);
    const result = handler({ content: "contains secret", sessionKey: "s1" });
    expect(result).toEqual({ block: true, replyText: expect.any(String) });
    expect(logger.records).toEqual([{ termId: "t", surface: "before_dispatch", action: "block", sessionKey: "s1" }]);
  });

  it("falls back to event.body when content is absent", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "t", pattern: "secret", action: "block" }] });
    const logger = fakeAuditLogger();
    const handler = createBeforeDispatchHandler(resolved, logger);
    const result = handler({ content: "", body: "contains secret" });
    expect(result).toEqual({ block: true, replyText: expect.any(String) });
  });

  it("fails closed (blocks) when the handler itself errors", () => {
    const resolved = resolveOutboundGuardConfig({ terms: [{ id: "t", pattern: "secret", action: "block" }] });
    const logger: AuditLogger = {
      record: () => {
        throw new Error("logger exploded");
      },
    };
    const handler = createBeforeDispatchHandler(resolved, logger);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = handler({ content: "contains secret" });
    expect(result).toEqual({ block: true, replyText: expect.any(String) });
    errorSpy.mockRestore();
  });
});
