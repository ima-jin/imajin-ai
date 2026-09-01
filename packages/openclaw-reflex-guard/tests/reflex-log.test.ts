import { describe, it, expect, vi } from "vitest";
import { createReflexLogger, DEFAULT_REFLEX_LOG_PATH } from "../src/reflex-log.js";

describe("createReflexLogger", () => {
  it("writes a record with ts and the given fields to the configured path", () => {
    const writeLine = vi.fn().mockResolvedValue(undefined);
    const logger = createReflexLogger("custom/reflex-log.jsonl", writeLine);
    logger.record({ warranted: true, triggers: ["external-send"], findings: [], reaction: null });
    const [path, record] = writeLine.mock.calls[0];
    expect(path).toBe("custom/reflex-log.jsonl");
    expect(record).toMatchObject({ warranted: true, triggers: ["external-send"], findings: [], reaction: null });
    expect(typeof (record as { ts: string }).ts).toBe("string");
  });

  it("defaults to DEFAULT_REFLEX_LOG_PATH when no path is given", () => {
    const writeLine = vi.fn().mockResolvedValue(undefined);
    const logger = createReflexLogger(undefined, writeLine);
    logger.record({ warranted: false, triggers: [], findings: [] });
    const [path] = writeLine.mock.calls[0];
    expect(path).toBe(DEFAULT_REFLEX_LOG_PATH);
  });

  it("does not throw when the underlying write fails", async () => {
    const writeLine = vi.fn().mockRejectedValue(new Error("disk full"));
    const logger = createReflexLogger("p.jsonl", writeLine);
    expect(() => logger.record({ warranted: true, triggers: [], findings: [] })).not.toThrow();
    await writeLine.mock.results[0].value.catch(() => {});
  });
});
