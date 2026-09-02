#!/usr/bin/env node
/**
 * usage-emitter CLI (imajin-ai#1932, #1151) — one invocation:
 *   1. tail every `.jsonl` file under the NanoClaw agent group's
 *      `.claude-shared/projects/` directory for new lines
 *   2. map assistant lines with usage into `usage.incurred` rows, source
 *      `harness:nanoclaw`
 *   3. POST them to the kernel, in batches, deduped by `external_id`
 *   4. persist the tail cursor only after a successful post
 *
 * Run periodically (cron / systemd timer) — see the package README for
 * setup, including the one-time `PUT /usage/api/emitters` registration step
 * (performed by the OWNER, not this script — see `bootstrap-identity.ts`'s
 * header comment for why).
 */
import { chunkRows, postIncurredBatch } from './client.js';
import { mapJsonlLines } from './mapper.js';
import { loadState, saveState, tailNewLines } from './tail.js';

async function main(): Promise<void> {
  const kernelUrl = process.env.KERNEL_URL;
  const token = process.env.USAGE_EMIT_TOKEN;
  const projectsDir = process.env.NANOCLAW_PROJECTS_DIR;
  const stateFilePath = process.env.USAGE_EMITTER_STATE_FILE;

  if (!kernelUrl || !token || !projectsDir || !stateFilePath) {
    console.error(
      'usage-emitter: KERNEL_URL, USAGE_EMIT_TOKEN, NANOCLAW_PROJECTS_DIR, and USAGE_EMITTER_STATE_FILE are required.',
    );
    process.exitCode = 1;
    return;
  }

  const previousState = loadState(stateFilePath);
  const { rawLines, state: nextState } = tailNewLines(projectsDir, previousState);
  const rows = mapJsonlLines(rawLines);

  if (rows.length === 0) {
    console.log('usage-emitter: no new usage rows to report.');
    saveState(stateFilePath, nextState);
    return;
  }

  let inserted = 0;
  let skipped = 0;
  for (const batch of chunkRows(rows)) {
    const result = await postIncurredBatch({ kernelUrl, token }, batch);
    inserted += result.inserted;
    skipped += result.skipped;
    if (result.rejected.length > 0) {
      console.warn(`usage-emitter: ${result.rejected.length} row(s) rejected:`, result.rejected);
    }
  }

  saveState(stateFilePath, nextState);
  console.log(`usage-emitter: inserted ${inserted}, skipped ${skipped} (already recorded).`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err: unknown) => {
    console.error('usage-emitter: fatal error', err);
    process.exitCode = 1;
  });
}

export { main };
