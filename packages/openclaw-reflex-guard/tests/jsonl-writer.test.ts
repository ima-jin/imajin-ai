import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonlLine } from "../src/jsonl-writer.js";

describe("appendJsonlLine", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("creates the parent directory and appends a JSON line", async () => {
    dir = await mkdtemp(join(tmpdir(), "reflex-guard-jsonl-"));
    const filePath = join(dir, "nested", "audit-log.jsonl");

    await appendJsonlLine(filePath, { a: 1 });
    await appendJsonlLine(filePath, { a: 2 });

    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ a: 2 });
  });
});
