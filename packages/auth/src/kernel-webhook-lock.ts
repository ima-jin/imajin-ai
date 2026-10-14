import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// Never unlink the lock inode: doing so could split ownership across two inodes.
// The helper exits on parent pipe EOF (including SIGKILL). The OS releases the
// lock; legacy empty/malformed files need no destructive stale-lock recovery.
const HELPER = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], process.argv[2], { mode: 0o600 });
process.stdout.write('locked\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

/** Requires util-linux flock on the server; unavailable runtimes fail closed. */
export async function withKernelPinLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const owner = JSON.stringify({
    pid: process.pid, host: hostname(), timestamp: Date.now(), token: randomUUID(),
  });
  const child = spawn('flock', ['--exclusive', '--timeout', '10', path, process.execPath, '-e', HELPER, path, owner], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  child.stdin.on('error', () => { /* Exit/error events report acquisition failures. */ });
  let ready = false;
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (ready && code === 0) resolve();
      else reject(new Error('Kernel pin OS lock unavailable or timed out'));
    });
  });
  const acquired = new Promise<void>((resolve) => {
    child.stdout.once('data', () => { ready = true; resolve(); });
  });
  try {
    await Promise.race([acquired, exited]);
    return await operation();
  } finally {
    child.stdin.end();
    await exited;
  }
}
