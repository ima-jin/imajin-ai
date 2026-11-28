import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
let server;
let work;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  }
  if (work) { await rm(work, { recursive: true, force: true }); work = undefined; }
});

async function faultFixture(source, statePath, ecosystem) {
  const faults = {
    'abandoned-lock': () => writeFile(`${statePath}.lock`, '2147483647', { mode: 0o600 }),
    'live-lock': () => writeFile(`${statePath}.lock`, String(process.pid)),
    'invalid-lock': () => writeFile(`${statePath}.lock`, '0'),
    'recovery-busy': async () => {
      await writeFile(`${statePath}.lock`, '2147483647');
      await writeFile(`${statePath}.lock.recovery`, 'busy');
    },
    'invalid-state': () => writeFile(statePath, '{'),
    'state-write': () => mkdir(`${statePath}.tmp`),
    'invalid-config': () => writeFile(ecosystem, 'throw new Error("Do not log arbitrary config text");'),
  };
  await faults[source]?.();
}

function checkResult(result, source, statePath, ecosystem, scope) {
  const output = result.stdout + result.stderr;
  expect(output).not.toContain('Do not log arbitrary');
  expect(output).not.toContain('inspect configuration');
  const diagnostic = {
    'live-lock': ['state lock', `${statePath}.lock`, 'EEXIST'],
    'invalid-lock': ['state lock', `${statePath}.lock`, 'INVALID_OR_UNAVAILABLE'],
    'recovery-busy': ['state lock recovery', `${statePath}.lock.recovery`, 'EEXIST'],
    'invalid-state': ['state read/parse', statePath, 'INVALID_OR_UNAVAILABLE'],
    'state-write': ['state write', `${statePath}.tmp`],
    'invalid-config': ['configuration', ecosystem, 'INVALID_OR_UNAVAILABLE'],
    'pm2-unavailable': ['PM2 pid', `${scope}-jin`, 'ENOENT'],
  }[source];
  const expectedExit = source === 'invalid-config' ? 2
    : Number(Boolean(diagnostic) || ['failed-delivery', 'kernel-failure'].includes(source));
  expect(result.code ?? 0, output).toBe(expectedExit);
  for (const part of diagnostic ?? []) {
    expect(output).toContain(part.includes(work) ? JSON.stringify(part) : part);
  }
  return Boolean(diagnostic);
}

const sources = ['cron', 'post-deploy', 'dry-run', 'no-webhook-healthy', 'failed-delivery', 'abandoned-lock',
  'live-lock', 'invalid-lock', 'recovery-busy', 'invalid-state', 'state-write', 'invalid-config', 'pm2-unavailable', 'kernel-failure'];
it.each(['dev', 'prod'].flatMap(scope => sources.map(source => [scope, source])))('verifies %s %s without leaking its URL', async (scope, source) => {
  const workflow = parse(await readFile(join(root, `.github/workflows/deploy-${scope}.yml`), 'utf8'));
  const step = workflow.jobs.deploy.steps.find(value => value.name === 'Post-deploy pm2 health check');
  expect(step.env).toEqual({ PM2_ALERT_WEBHOOK_FILE: `/home/jin/.config/imajin/pm2-alert-webhook.${scope}` });
  expect(step.run).toContain(`./scripts/pm2-health-check.sh ${scope}`);
  const receipts = [];
  server = createServer((request, response) => {
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        receipts.push(JSON.parse(body));
        response.writeHead(request.url === '/unavailable' ? 503 : 200);
        response.end('{}');
      });
    } else {
      response.writeHead(request.url === '/undeclared'
        || (source === 'kernel-failure' && request.url === '/api/health?liveness=1') ? 404 : 200);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  work = await mkdtemp(join(tmpdir(), 'watchdog-wrapper-'));
  const bin = join(work, 'bin');
  await mkdir(bin);
  const ecosystem = join(work, 'ecosystem.cjs');
  await writeFile(ecosystem, `module.exports = { apps: [
    { name: '${scope}-jin', cwd: '/repo/apps/kernel', env: { PORT: ${port} } },
    { name: '${scope}-declared', cwd: '/independent', env: { PORT: ${port}, LIVENESS_PATH: '/health' } },
    { name: '${scope}-undeclared', cwd: '/independent', env: { PORT: ${port} } }
  ] };`);
  await writeFile(join(bin, 'pm2'), `#!/usr/bin/env bash\nprintf '[{"name":"${scope}-jin","pm2_env":{"status":"online","restart_time":0}}]'\n`, { mode: 0o755 });
  // Only PM2 pid/restart is virtual. The wrapper, probe, state and HTTP delivery run for real.
  const preload = join(work, 'pm2-fixture.cjs');
  await writeFile(preload, `const child = require('node:child_process');
const original = child.execFile;
child.execFile = (file, args, options, callback) => {
  if (file === 'pm2') {
    if (args[0] !== 'pid') throw new Error('Unexpected PM2 command');
    if (process.env.FIXTURE_PM2_UNAVAILABLE === '1') {
      callback(Object.assign(new Error('Do not log arbitrary subprocess output'), { code: 'ENOENT' }));
      return;
    }
    callback(null, '123', '');
    return;
  }
  return original(file, args, options, callback);
};
child.execFile[require('node:util').promisify.custom] = (file, args, options) =>
  new Promise((resolve, reject) => child.execFile(file, args, options,
    (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
`);
  const event = { id: 'pending-target', app: `${scope}-jin`, outcome: 'restarted' };
  const statePath = join(work, `${scope}.json`);
  const noReceipt = ['dry-run', 'no-webhook-healthy'].includes(source);
  await writeFile(statePath, JSON.stringify({ events: noReceipt ? [] : [{ event, delivered: false }] }));
  await faultFixture(source, statePath, ecosystem);
  const webhookFile = join(work, source === 'post-deploy' ? basename(step.env.PM2_ALERT_WEBHOOK_FILE) : 'cron-webhook');
  const webhook = `http://127.0.0.1:${port}/${source === 'failed-delivery' ? 'unavailable' : 'receipt'}`;
  if (source !== 'no-webhook-healthy') await writeFile(webhookFile, `${webhook}\n`, { mode: 0o600 });
  const env = {
    ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`,
    IMAJIN_LIVENESS_STATE_DIR: work, PM2_ALERT_WEBHOOK_FILE: webhookFile,
    AUTH_INTERNAL_API_KEY: '', RESTART_ALERT_WEBHOOK: '', STATUS_ALERT_WEBHOOK: '',
    PM2_HEALTH_LIVENESS: '1', RESTART_ALERT_STATE: join(work, 'restarts.json'),
    STATUS_ALERT_STATE: join(work, 'status.json'), PM2_DEPLOY_STOPPED_FILE: '',
    FIXTURE_PM2_UNAVAILABLE: source === 'pm2-unavailable' ? '1' : '0',
  };
  const invocation = source === 'dry-run'
    ? [process.execPath, ['deploy/liveness-probe.mjs', '--env', scope, '--once', '--watchdog', '--ecosystem', ecosystem]]
    : [bash, ['scripts/pm2-health-check.sh', scope, ecosystem.replaceAll('\\', '/')]];
  let result;
  try { result = await exec(...invocation, {
    cwd: root, env, timeout: 20_000,
  }); } catch (error) { result = error; }
  expect(result.stdout + result.stderr).not.toContain(webhook);
  if (checkResult(result, source, statePath, ecosystem, scope)) return;
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  expect(Object.keys(state.apps)).toEqual([`${scope}-jin`, `${scope}-declared`]);
  expect(state.events).toEqual(noReceipt ? [] : [{ event, delivered: source !== 'failed-delivery' }]);
  expect(receipts).toEqual(noReceipt ? [] : [{ text: `HTTP liveness: ${scope}-jin restarted`, ...event }]);
}, 25_000);
