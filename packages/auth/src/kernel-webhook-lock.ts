import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';

// Never unlink the lock inode: doing so could split ownership across two inodes.
// flock(2) ownership belongs to the shared open-file-description. The child
// locks inherited fd3 and exits; the parent's open descriptor keeps ownership
// until close/crash. No long-lived helper can die and silently lose our lease.
// Empty/malformed legacy files need no destructive stale-lock recovery.

function acquire(file: FileHandle): Promise<void> {
  const child = spawn('/usr/bin/flock', ['--exclusive', '--timeout', '10', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', file.fd],
  });
  child.stderr?.resume();
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Kernel pin OS lock unavailable or timed out'));
    });
  });
}

/** Requires Linux util-linux /usr/bin/flock; missing binaries fail closed, never search PATH. */
export async function withKernelPinLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const file = await open(path, 'a+', 0o600);
  try {
    await acquire(file);
    await file.truncate(0);
    await file.writeFile(JSON.stringify({
      pid: process.pid, host: hostname(), timestamp: Date.now(), token: randomUUID(),
    }));
    return await operation();
  } finally {
    await file.close();
  }
}
