#!/usr/bin/env node
/**
 * usage-emitter CLI (imajin-ai#1932, #1151). Same CONTRACT as
 * `packages/usage-emitter-claude-code`'s CLI entry (tail -> map -> post in
 * batches -> persist the cursor only after a successful post) but pointed
 * at a NanoClaw agent group's session JSONL, source `harness:nanoclaw`, and
 * implemented independently.
 *
 * Run periodically (cron / systemd timer) — see the package README for
 * setup, including the one-time `PUT /usage/api/emitters` registration step
 * (performed by the OWNER, not this script — see `bootstrap-identity.ts`'s
 * header comment for why).
 */
import { chunkRows, postIncurredBatch } from './client.js';
import { mapJsonlLines } from './mapper.js';
import { loadState, saveState, tailNewLines } from './tail.js';

interface EmitterEnv {
  kernelUrl: string;
  token: string;
  projectsDir: string;
  stateFilePath: string;
}

const REQUIRED_ENV_VARS = ['KERNEL_URL', 'USAGE_EMIT_TOKEN', 'NANOCLAW_PROJECTS_DIR', 'USAGE_EMITTER_STATE_FILE'] as const;

function readEnv(env: NodeJS.ProcessEnv): EmitterEnv | undefined {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`usage-emitter: missing required env var(s): ${missing.join(', ')}`);
    return undefined;
  }
  return {
    kernelUrl: env.KERNEL_URL!,
    token: env.USAGE_EMIT_TOKEN!,
    projectsDir: env.NANOCLAW_PROJECTS_DIR!,
    stateFilePath: env.USAGE_EMITTER_STATE_FILE!,
  };
}

interface PostSummary {
  inserted: number;
  skipped: number;
}

async function postAllBatches(config: EmitterEnv, rows: ReturnType<typeof mapJsonlLines>): Promise<PostSummary> {
  const batches = chunkRows(rows);
  let summary: PostSummary = { inserted: 0, skipped: 0 };
  for (const batch of batches) {
    const result = await postIncurredBatch({ kernelUrl: config.kernelUrl, token: config.token }, batch);
    summary = { inserted: summary.inserted + result.inserted, skipped: summary.skipped + result.skipped };
    if (result.rejected.length > 0) {
      console.warn(`usage-emitter: ${result.rejected.length} row(s) rejected:`, result.rejected);
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const config = readEnv(process.env);
  if (!config) {
    process.exitCode = 1;
    return;
  }

  const previousState = loadState(config.stateFilePath);
  const { rawLines, state: nextState } = tailNewLines(config.projectsDir, previousState);
  const rows = mapJsonlLines(rawLines);

  if (rows.length === 0) {
    console.log('usage-emitter: no new usage rows to report.');
    saveState(config.stateFilePath, nextState);
    return;
  }

  const { inserted, skipped } = await postAllBatches(config, rows);

  // Persisted only after every batch posts successfully — a failed request
  // leaves the cursor where it was, so the next run re-tails (and re-dedupes
  // via external_id) rather than losing rows.
  saveState(config.stateFilePath, nextState);
  console.log(`usage-emitter: inserted ${inserted}, skipped ${skipped} (already recorded).`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    await main();
  } catch (err: unknown) {
    console.error('usage-emitter: fatal error', err);
    process.exitCode = 1;
  }
}

export { main };
