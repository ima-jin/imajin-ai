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

/** Strips control characters (CR/LF and friends) before writing untrusted strings to the console, so a malicious/unexpected kernel response or error message can't forge extra log lines. */
function sanitizeForLog(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control chars to prevent log injection (SonarCloud tssecurity:S5145)
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ');
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

  console.log(`Provision ${sanitizeForLog(result.provision.id)} (${sanitizeForLog(result.provision.placement)}): wrote ${result.filesWritten.length} file(s) to ${result.outDir}.`);
  if (args.dryRun) {
    console.log('[dry-run] No files were actually written, no compose command ran, and no callback was sent.');
    for (const path of result.filesWritten) console.log(`  - ${path}`);
  } else {
    console.log(`compose ran: ${result.composeRan}, callback sent: ${result.callbackSent}`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    await main();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('claw-provisioner: fatal error', sanitizeForLog(message));
    process.exitCode = 1;
  }
}
