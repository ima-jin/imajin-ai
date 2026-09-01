import { describe, it, expect, vi } from "vitest";
import { createAuditLogger } from "../src/audit-log.js";

describe("createAuditLogger", () => {
  it("writes a redacted JSONL record with ts, termId, surface, action, sessionKey", async () => {
    const writeLine = vi.fn().mockResolvedValue(undefined);
    const logger = createAuditLogger("some/path.jsonl", writeLine);

    logger.record({ termId: "term-1", surface: "message_sending", action: "block", sessionKey: "sess-1" });

    expect(writeLine).toHaveBeenCalledTimes(1);
    const [path, record] = writeLine.mock.calls[0];
    expect(path).toBe("some/path.jsonl");
    expect(record).toMatchObject({
      termId: "term-1",
      surface: "message_sending",
      action: "block",
      sessionKey: "sess-1",
    });
    expect(typeof (record as { ts: string }).ts).toBe("string");
    // Redaction: no matched text / pattern fields ever appear in the record.
    expect(record).not.toHaveProperty("content");
    expect(record).not.toHaveProperty("pattern");
    expect(record).not.toHaveProperty("matchedText");
  });

  it("omits sessionKey when not provided", () => {
    const writeLine = vi.fn().mockResolvedValue(undefined);
    const logger = createAuditLogger("p.jsonl", writeLine);
    logger.record({ termId: "t", surface: "before_dispatch", action: "flag" });
    const [, record] = writeLine.mock.calls[0];
    expect((record as { sessionKey?: string }).sessionKey).toBeUndefined();
  });

  it("does not throw when the underlying write fails (fire-and-forget)", async () => {
    const writeLine = vi.fn().mockRejectedValue(new Error("disk full"));
    const logger = createAuditLogger("p.jsonl", writeLine);
    expect(() => logger.record({ termId: "t", surface: "message_sending", action: "block" })).not.toThrow();
    // Let the rejected promise's .catch() run before the test exits.
    await writeLine.mock.results[0].value.catch(() => {});
  });
});
