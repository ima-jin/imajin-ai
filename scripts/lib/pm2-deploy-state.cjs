// Deploy-only intentional-stop policy (#2815). Never persist pm2's full env.
// CLI reads jlist on stdin: <scope> --snapshot <file> before builds;
// <scope> <file> selects restart names; <scope> --build <name> guards build.sh.
// Health/listener callers share isIntentionallyStopped and stoppedNames.
const fs = require('node:fs');

function readProcesses(input) {
  const procs = JSON.parse(input);
  if (!Array.isArray(procs)) throw new Error('pm2 jlist must be an array');
  return procs;
}

function stoppedNames(file = process.env.PM2_DEPLOY_STOPPED_FILE) {
  if (!file) return new Set(); // Cron retains its existing alert policy.
  const names = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new Error('invalid deploy stopped-process list');
  }
  return new Set(names);
}

function isIntentionallyStopped(proc, stopped) {
  return proc?.pm2_env?.status === 'stopped' && stopped.has(proc.name);
}
function mayRestart(procs, name) {
  const matches = procs.filter((proc) => proc?.name === name);
  const skipped = matches.filter((proc) => proc.pm2_env?.status === 'stopped');
  for (const proc of skipped) {
    console.error(`Skipping ${name}: pm2 status=${proc.pm2_env.status} (preserving deliberate stop)`);
  }
  // Absent is not deliberately stopped. A name-based restart affects all
  // cluster instances, so one stopped instance excludes the whole name.
  if (skipped.length) return false;
  for (const proc of matches) {
    const status = proc.pm2_env?.status;
    if (status !== 'online') {
      console.error(`Restarting ${name}: pm2 status=${status || 'unknown'} (deploy recovery)`);
    }
  }
  return true;
}

function scopedProcesses(procs, scope) {
  if (!['dev', 'prod'].includes(scope)) throw new Error('expected dev|prod');
  return procs.filter((proc) => proc?.name?.startsWith(`${scope}-`) && proc.name !== 'prod-jin');
}

function snapshotStopped(procs, scope, file) {
  const stopped = new Set(scopedProcesses(procs, scope)
    .filter((proc) => proc.pm2_env?.status === 'stopped').map((proc) => proc.name));
  fs.writeFileSync(file, JSON.stringify([...stopped]), { mode: 0o600 });
}

function restartNames(procs, scope) {
  const candidates = new Set(scopedProcesses(procs, scope).map((proc) => proc.name));
  // #2550: absent is not deliberately stopped; bootstrap the scheduler.
  candidates.add(`${scope}-kernel-cron`);
  return [...candidates].filter((name) => mayRestart(procs, name));
}

module.exports = { readProcesses, stoppedNames, isIntentionallyStopped, restartNames, mayRestart, snapshotStopped };

if (require.main === module) {
  try {
    const [scope, file, name] = process.argv.slice(2);
    if (!['dev', 'prod'].includes(scope)) throw new Error('expected dev|prod');
    const procs = readProcesses(fs.readFileSync(0, 'utf8'));
    if (file === '--build') {
      console.log(name === 'prod-jin' || mayRestart(procs, name) ? 'restart' : 'skip');
    } else if (file === '--snapshot') {
      snapshotStopped(procs, scope, name);
    } else {
      stoppedNames(file); // A missing/corrupt deploy snapshot must fail loudly.
      console.log(restartNames(procs, scope).join(' '));
    }
  } catch {
    console.error('pm2-deploy-state: could not read pm2 state or write stopped-process list');
    process.exitCode = 2;
  }
}
