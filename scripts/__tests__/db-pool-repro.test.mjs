import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([
  '',
  'postgres://db.example.test/imajin_runtime_repro',
  'postgres://127.0.0.1/not_the_disposable_database',
])('refuses a missing, remote or non-disposable reproduction target', target => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('../repro-db-pool-stall.ts', import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, DB_BOUNDS_REPRO_URL: target },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Pool-stall repro failed');
  if (target) expect(result.stderr).not.toContain(target);
});
