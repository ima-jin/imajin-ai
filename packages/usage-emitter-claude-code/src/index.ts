#!/usr/bin/env node
/**
 * usage-emitter-claude-code CLI (#1151) — one invocation:
 *   1. tail every `.jsonl` file under `~/.claude/projects/` for new lines
 *   2. map assistant lines with usage into `usage.incurred` rows
 *   3. POST them to the kernel, in batches, deduped by `external_id`
 *   4. persist the tail cursor only after a successful post
 *
 * Run periodically (cron / systemd timer) — see README.md for setup,
 * including the one-time `PUT /usage/api/emitters` registration step and why
 * this is not a long-lived daemon.
 */
import { defaultProjectsDir, defaultStateFilePath, loadState, saveState, tailNewLines } from './tail';
import { mapJsonlLines } from './mapper';
import { postIncurredBatch, chunkRows } from './client';

async function main(): Promise<void> {
  const kernelUrl = process.env.KERNEL_URL;
  const token = process.env.USAGE_EMIT_TOKEN;
  if (!kernelUrl || !token) {
    console.error('usage-emitter-claude-code: KERNEL_URL and USAGE_EMIT_TOKEN environment variables are required.');
    process.exitCode = 1;
    return;
  }

  const projectsDir = process.env.CLAUDE_PROJECTS_DIR ?? defaultProjectsDir();
  const stateFilePath = process.env.USAGE_EMITTER_STATE_FILE ?? defaultStateFilePath();

  const previousState = loadState(stateFilePath);
  const { rawLines, state: nextState } = tailNewLines(projectsDir, previousState);
  const rows = mapJsonlLines(rawLines);

  if (rows.length === 0) {
    console.log('usage-emitter-claude-code: no new usage rows to report.');
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
      console.warn(`usage-emitter-claude-code: ${result.rejected.length} row(s) rejected:`, result.rejected);
    }
  }

  // Persisted only after every batch posts successfully — a failed request
  // leaves the cursor where it was, so the next run re-tails (and re-dedupes
  // via external_id) rather than losing rows.
  saveState(stateFilePath, nextState);
  console.log(`usage-emitter-claude-code: inserted ${inserted}, skipped ${skipped} (already recorded).`);
}

// Only run when invoked directly (`tsx src/index.ts` / `pnpm start`), not
// when imported — keeps this module import-safe for tooling/tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('usage-emitter-claude-code: fatal error', err);
    process.exitCode = 1;
  });
}

export { main };
