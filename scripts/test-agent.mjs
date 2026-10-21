import { fileURLToPath } from 'node:url';
import { parseCLI, startVitest } from 'vitest/node';
import { fork } from 'node:child_process';

// The agent-facing entrypoint auto-selects quiet output in Warp/CI. The
// explicit test:agent script forces it even in a developer's local shell.
const args = process.argv.slice(2);
const forceAgent = args.includes('--agent');
const { filter, options } = parseCLI(['vitest', 'run', ...args.filter((arg) => arg !== '--agent')]);
const agent = forceAgent || process.env.WARP_AGENT === '1' || Boolean(process.env.CI);
if (agent) {
  // Some tests use process.stdout.write or subprocess stdio, bypassing
  // onUserConsoleLog entirely. Only the reporter's IPC channel is published.
  const worker = fork(fileURLToPath(new URL('./test-agent-worker.mjs', import.meta.url)),
    args.filter((arg) => arg !== '--agent'), { silent: true });
  let diagnostics = '';
  let reportedFailure = false;
  let reportedOutput = false;
  const capture = (chunk) => { diagnostics = (diagnostics + chunk).slice(-65536); };
  worker.stdout.on('data', capture);
  worker.stderr.on('data', capture);
  worker.on('message', (message) => {
    if (message.type === 'agent-output') {
      reportedOutput = true;
      process.stdout.write(`${message.line}\n`);
    }
    if (message.type === 'agent-failure') reportedFailure = true;
  });
  const interrupt = () => worker.kill('SIGINT');
  const terminate = () => worker.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  worker.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  worker.on('close', (code, signal) => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    // Configuration/coverage/worker failures have no failing test to report.
    // Preserve those diagnostics, including Vitest's no-tests-found message.
    if (!reportedFailure && diagnostics && (code !== 0 || !reportedOutput)) {
      process.stderr.write(diagnostics);
    }
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} else {
  const ctx = await startVitest('test', filter, options);
  await ctx?.close();
}
