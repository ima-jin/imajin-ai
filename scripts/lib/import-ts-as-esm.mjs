// TEMPORARY (#2483 proof commit, to be reverted): emulate the old tsx/CJS
// entrypoint. Loads the kernel modules the way `pnpm exec tsx` did (typeless
// .ts => CommonJS) in a child process and fails if that fails; then falls
// through to the real ESM loader.
import { spawnSync } from 'node:child_process';
import { importTsAsEsm as realImport } from './import-ts-as-esm.real.mjs';

export async function importTsAsEsm(entryFile) {
  const probe = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', `import(${JSON.stringify(entryFile)}).then((m) => (m.loadKernelModules ?? m.default.loadKernelModules)()).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); })`],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error(probe.stderr.trim().split('\n')[0]);
  return realImport(entryFile);
}
