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

it.each(['cron', 'post-deploy', 'dry-run', 'failed-delivery'])('verifies the %s health-check environment without leaking its URL', async source => {
  const workflow = parse(await readFile(join(root, '.github/workflows/deploy-prod.yml'), 'utf8'));
  const step = workflow.jobs.deploy.steps.find(value => value.name === 'Post-deploy pm2 health check');
  expect(step.env).toEqual({ PM2_ALERT_WEBHOOK_FILE: '/home/jin/.config/imajin/pm2-alert-webhook.prod' });
  expect(step.run).toContain('./scripts/pm2-health-check.sh prod');
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
      response.writeHead(request.url === '/undeclared' ? 404 : 200);
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
    { name: 'prod-jin', cwd: '/repo/apps/kernel', env: { PORT: ${port} } },
    { name: 'prod-declared', cwd: '/independent', env: { PORT: ${port}, LIVENESS_PATH: '/health' } },
    { name: 'prod-undeclared', cwd: '/independent', env: { PORT: ${port} } }
  ] };`);
  await writeFile(join(bin, 'pm2'), '#!/usr/bin/env bash\nprintf \'[{"name":"prod-jin","pm2_env":{"status":"online","restart_time":0}}]\'\n', { mode: 0o755 });
  // Only PM2 pid/restart is virtual. The wrapper, probe, state and HTTP delivery run for real.
  const preload = join(work, 'pm2-fixture.cjs');
  await writeFile(preload, `const child = require('node:child_process');
const original = child.execFile;
child.execFile = (file, args, options, callback) => {
  if (file === 'pm2') {
    if (args[0] !== 'pid') throw new Error('Unexpected PM2 command');
    callback(null, '123', '');
    return;
  }
  return original(file, args, options, callback);
};
child.execFile[require('node:util').promisify.custom] = (file, args, options) =>
  new Promise((resolve, reject) => child.execFile(file, args, options,
    (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
`);
  const event = { id: 'pending-target', app: 'prod-jin', outcome: 'restarted' };
  const statePath = join(work, 'prod.json');
  await writeFile(statePath, JSON.stringify({ events: source === 'dry-run' ? [] : [{ event, delivered: false }] }));
  const webhookFile = join(work, source === 'post-deploy' ? basename(step.env.PM2_ALERT_WEBHOOK_FILE) : 'cron-webhook');
  const webhook = `http://127.0.0.1:${port}/${source === 'failed-delivery' ? 'unavailable' : 'receipt'}`;
  await writeFile(webhookFile, `${webhook}\n`, { mode: 0o600 });
  const env = {
    ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`,
    IMAJIN_LIVENESS_STATE_DIR: work, PM2_ALERT_WEBHOOK_FILE: webhookFile,
    AUTH_INTERNAL_API_KEY: '', RESTART_ALERT_WEBHOOK: '', STATUS_ALERT_WEBHOOK: '',
    PM2_HEALTH_LIVENESS: '1', RESTART_ALERT_STATE: join(work, 'restarts.json'),
    STATUS_ALERT_STATE: join(work, 'status.json'), PM2_DEPLOY_STOPPED_FILE: '',
  };
  const invocation = source === 'dry-run'
    ? [process.execPath, ['deploy/liveness-probe.mjs', '--env', 'prod', '--once', '--watchdog', '--ecosystem', ecosystem]]
    : [bash, ['scripts/pm2-health-check.sh', 'prod', ecosystem.replaceAll('\\', '/')]];
  let result;
  try { result = await exec(...invocation, {
    cwd: root, env, timeout: 20_000,
  }); } catch (error) { result = error; }
  expect(result.code ?? 0).toBe(source === 'failed-delivery' ? 1 : 0);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  expect(Object.keys(state.apps)).toEqual(['prod-jin', 'prod-declared']);
  expect(state.events).toEqual(source === 'dry-run' ? [] : [{ event, delivered: source !== 'failed-delivery' }]);
  expect(receipts).toEqual(source === 'dry-run' ? [] : [{ text: 'HTTP liveness: prod-jin restarted', ...event }]);
  expect(result.stdout + result.stderr).not.toContain(webhook);
}, 25_000);
