// Deploy-only intentional-stop policy (#2815). Never persist pm2's full env.
const fs = require('node:fs');

function readProcesses(input) {
  const procs = JSON.parse(input);
  if (!Array.isArray(procs)) throw new Error('pm2 jlist must be an array');
  return procs;
}

function stoppedNames() {
  const file = process.env.PM2_DEPLOY_STOPPED_FILE;
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

function restartNames(procs, scope, file) {
  if (!['dev', 'prod'].includes(scope)) throw new Error('expected dev|prod');
  const selected = new Set();
  const stopped = new Set();
  const skipped = new Set();
  for (const proc of procs) {
    if (!proc?.name?.startsWith(`${scope}-`) || proc.name === 'prod-jin') continue;
    const status = proc.pm2_env?.status;
    if (status === 'online') {
      selected.add(proc.name);
    } else {
      skipped.add(proc.name);
      console.error(`Skipping ${proc.name}: pm2 status=${status || 'unknown'} (not online)`);
      if (status === 'stopped') stopped.add(proc.name);
    }
  }
  // #2550: absent is not deliberately stopped; bootstrap the scheduler.
  const cron = `${scope}-kernel-cron`;
  if (!procs.some((proc) => proc?.name === cron)) selected.add(cron);
  fs.writeFileSync(file, JSON.stringify([...stopped]), { mode: 0o600 });
  // A name-based restart affects every cluster instance of that name.
  return [...selected].filter((name) => !skipped.has(name));
}

module.exports = { readProcesses, stoppedNames, isIntentionallyStopped, restartNames };

if (require.main === module) {
  try {
    const [scope, file] = process.argv.slice(2);
    console.log(restartNames(readProcesses(fs.readFileSync(0, 'utf8')), scope, file).join(' '));
  } catch {
    console.error('pm2-deploy-state: could not read pm2 state or write stopped-process list');
    process.exitCode = 2;
  }
}
