/**
 * Minimal append-only JSONL writer shared by the Layer 1 audit log
 * (`src/audit-log.ts`) and the Layer 2 reflex log (`src/reflex-log.ts`).
 *
 * Creates the parent directory on first write so a fresh install with no
 * pre-existing log directory does not fail the first audit/reflex record.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendJsonlLine(filePath: string, record: unknown): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const dir = dirname(filePath);
  if (dir && dir !== ".") {
    await mkdir(dir, { recursive: true });
  }
  await appendFile(filePath, line, "utf8");
}
