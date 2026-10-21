import { parseCLI, startVitest } from 'vitest/node';
import AgentReporter from './agent-reporter.mjs';

// This process is owned by test-agent.mjs. Raw stdout/stderr are private;
// structured reporter messages are the only ordinary agent-visible output.
const { filter, options } = parseCLI(['vitest', 'run', ...process.argv.slice(2)]);
process.env.VITE_CJS_IGNORE_WARNING = 'true';
options.reporters = [new AgentReporter({
  write: (line) => process.send({ type: 'agent-output', line }),
  onFailure: () => process.send({ type: 'agent-failure' }),
})];
options.coverage = { ...options.coverage, reporter: ['lcov'] };
try {
  const ctx = await startVitest('test', filter, options);
  await ctx?.close();
} finally {
  // Drain queued messages before disconnecting so the final summary survives.
  if (process.connected) process.disconnect();
}
