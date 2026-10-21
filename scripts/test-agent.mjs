import { fileURLToPath } from 'node:url';
import { parseCLI, startVitest } from 'vitest/node';

// The agent-facing entrypoint auto-selects quiet output in Warp/CI. The
// explicit test:agent script forces it even in a developer's local shell.
const args = process.argv.slice(2);
const forceAgent = args.includes('--agent');
const { filter, options } = parseCLI(['vitest', 'run', ...args.filter((arg) => arg !== '--agent')]);
const agent = forceAgent || process.env.WARP_AGENT === '1' || Boolean(process.env.CI);
if (agent) {
  // The root TS config is loaded through Vite's CJS compatibility API.
  // Suppress that specific deprecation notice, not runtime/test warnings.
  process.env.VITE_CJS_IGNORE_WARNING = 'true';
  options.reporters = [fileURLToPath(new URL('./agent-reporter.mjs', import.meta.url))];
  // Keep lcov for Sonar, but no passing-run coverage table in agent logs.
  options.coverage = { ...options.coverage, reporter: ['lcov'] };
}
const ctx = await startVitest('test', filter, options);
await ctx?.close();
