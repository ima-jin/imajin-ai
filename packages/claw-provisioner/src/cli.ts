#!/usr/bin/env node
/**
 * `claw-provisioner run --provision-id <id> --kernel-url <url> --operator-token <token> [--runner-token <token>] [--dry-run]`
 *
 * Operator-executed entry point for the envelope provisioner runner
 * (imajin-ai#1933). See `runner.ts` for the full behavior and v0 scope.
 */
import { runProvision } from './runner';

interface ParsedArgs {
  provisionId: string;
  kernelBaseUrl: string;
  operatorToken: string;
  runnerToken?: string;
  outDir?: string;
  composeDir?: string;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? undefined : argv[idx + 1];
  };
  const provisionId = get('--provision-id') ?? '';
  const kernelBaseUrl = get('--kernel-url') ?? process.env.KERNEL_BASE_URL ?? '';
  const operatorToken = get('--operator-token') ?? process.env.OPERATOR_TOKEN ?? '';
  const runnerToken = get('--runner-token') ?? process.env.PROVISIONER_RUNNER_TOKEN;
  const outDir = get('--out-dir');
  const composeDir = get('--compose-dir');
  const dryRun = argv.includes('--dry-run');

  if (!provisionId) throw new Error('--provision-id is required');
  if (!kernelBaseUrl) throw new Error('--kernel-url (or KERNEL_BASE_URL) is required');
  if (!operatorToken) throw new Error('--operator-token (or OPERATOR_TOKEN) is required');

  return { provisionId, kernelBaseUrl, operatorToken, runnerToken, outDir, composeDir, dryRun };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runProvision({
    kernelBaseUrl: args.kernelBaseUrl,
    provisionId: args.provisionId,
    operatorToken: args.operatorToken,
    runnerToken: args.runnerToken,
    outDir: args.outDir,
    composeDir: args.composeDir,
    dryRun: args.dryRun,
  });

  // JSON escapes control characters in every untrusted field, including paths.
  // Escape Unicode line separators too so each event stays on one physical line.
  console.log(JSON.stringify({
    event: 'provision-written',
    provisionId: args.provisionId,
    placement: result.provision.placement,
    fileCount: result.filesWritten.length,
    outDir: result.outDir,
  }).replaceAll('\u0085', '\\u0085').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'));
  if (args.dryRun) {
    console.log('[dry-run] No files were actually written, no compose command ran, and no callback was sent.');
    for (const path of result.filesWritten) {
      console.log(JSON.stringify({ event: 'provision-file', path })
        .replaceAll('\u0085', '\\u0085').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'));
    }
  } else {
    console.log(JSON.stringify({
      event: 'provision-status',
      composeRan: result.composeRan,
      callbackSent: result.callbackSent,
    }));
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    await main();
  } catch (err: unknown) {
    console.error(JSON.stringify({
      event: 'claw-provisioner-fatal',
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    }).replaceAll('\u0085', '\\u0085').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'));
    process.exitCode = 1;
  }
}
