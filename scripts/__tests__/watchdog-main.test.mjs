import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nodeConsole from 'node:console';
import { afterEach, expect, it, vi } from 'vitest';
import { main, deliverWatchdog, acquireStateLock } from '../../deploy/liveness-probe.mjs';

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('node:child_process', () => {
  const execFile = (...args) => command(...args);
  execFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => new Promise((resolve, reject) => {
    command(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  return { execFile };
});

async function inventoryFixture(failurePath) {
  const requests = [];
  server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(request.url === '/missing' || request.url === failurePath ? 404 : 200);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  work = await mkdtemp(join(tmpdir(), 'watchdog-targets-'));
  const ecosystem = join(work, 'ecosystem.cjs');
  await writeFile(ecosystem, `module.exports = { apps: [
    { name: 'prod-jin', cwd: '/repo/apps/kernel', env: { PORT: ${port} } },
    { name: 'prod-declared', cwd: '/elsewhere', env: { PORT: ${port}, LIVENESS_PATH: '/health' } },
    { name: 'prod-undeclared', cwd: '/elsewhere', env: { PORT: ${port} } }
  ] };`);
  vi.stubEnv('IMAJIN_LIVENESS_STATE_DIR', work);
  vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
  vi.stubEnv('RESTART_ALERT_WEBHOOK', '');
  vi.stubEnv('STATUS_ALERT_WEBHOOK', '');
  command.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, '123', ''));
  const args = ['--env', 'prod', '--once', '--watchdog', '--ecosystem', ecosystem];
  const statePath = join(work, 'prod.json');
  return { requests, port, ecosystem, args, statePath };
}

it.each([50, 264])('prunes %s obsolete pending receipts and counters on load, preserving delivered history', async count => {
  const f = await inventoryFixture();
  await writeFile(f.statePath, JSON.stringify({
    apps: { 'prod-undeclared': { failures: 3 } },
    events: [
      ...Array.from({ length: count }, () => ({ event: { app: 'prod-undeclared' }, delivered: false })),
      { event: { app: 'prod-undeclared', id: 'history' }, delivered: true },
    ],
  }));
  expect(await main(f.args)).toBe(true);
  expect(f.requests).toEqual(['/api/health?liveness=1', '/health']);
  expect(command.mock.calls.map(([, args]) => args)).toEqual([['pid', 'prod-jin'], ['pid', 'prod-declared']]);
  const state = JSON.parse(await readFile(f.statePath, 'utf8'));
  expect(state.apps['prod-undeclared']).toBeUndefined();
  expect(state.events).toEqual([{ event: { app: 'prod-undeclared', id: 'history' }, delivered: true }]);
});

it.each([false, true])('keeps real target receipts and returns delivery result %s', async delivered => {
  const f = await inventoryFixture();
  if (delivered) vi.stubEnv('RESTART_ALERT_WEBHOOK', `http://127.0.0.1:${f.port}/alert`);
  const event = { app: 'prod-declared', outcome: 'restarted', id: 'real-target' };
  await writeFile(f.statePath, JSON.stringify({ events: [{ event, delivered: false }] }));
  expect(await main([...f.args, '--execute'])).toBe(delivered);
  const state = JSON.parse(await readFile(f.statePath, 'utf8'));
  expect(state.events).toEqual([{ event, delivered }]);
});

it.each(['prod-jin', 'prod-declared'])('keeps a failing %s non-zero without executing in dry run', async app => {
  const f = await inventoryFixture(app === 'prod-jin' ? '/api/health?liveness=1' : undefined);
  const config = { apps: [
    { name: 'prod-jin', cwd: '/repo/apps/kernel', env: { PORT: f.port } },
    { name: 'prod-declared', cwd: '/elsewhere', env: { PORT: f.port, LIVENESS_PATH: '/health' } },
  ] };
  config.apps.find(target => target.name === app).env.LIVENESS_PATH = '/missing';
  // Use a different import URL so the module cache cannot hide the change.
  const ecosystem = join(work, 'failure.cjs');
  await writeFile(ecosystem, `module.exports = ${JSON.stringify(config)}`);
  const args = [...f.args.slice(0, -1), ecosystem];
  expect(await main(args)).toBe(false);
  expect(command.mock.calls.every(([, args]) => args[0] === 'pid')).toBe(true);
  const state = JSON.parse(await readFile(f.statePath, 'utf8'));
  expect(state.apps[app].failures).toBe(1);
  expect(state.events).toEqual([]);
});
let server;
let work;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  }
  if (work) { await rm(work, { recursive: true, force: true }); work = undefined; }
});

it('persists three cron failures, issues exactly one pm2 restart, and scopes it to prod', async () => {
  let healthy = false;
  let alerts = 0;
  server = createServer((request, response) => {
    if (request.url === '/alert') { alerts++; response.writeHead(200); }
    else {
      expect(request.url).toBe('/api/health?liveness=1');
      response.writeHead(healthy ? 200 : 503);
    }
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  work = await mkdtemp(join(tmpdir(), 'watchdog-3206-'));
  const ecosystem = join(work, 'ecosystem.cjs');
  await writeFile(ecosystem, `module.exports = { apps: [
    { name: 'prod-jin', cwd: '/prod/apps/kernel', env: { PORT: ${port} } },
    { name: 'dev-jin', cwd: '/dev/apps/kernel', env: { PORT: ${port} } },
    { name: 'prod-kernel-cron' }
  ] };`);
  vi.stubEnv('IMAJIN_LIVENESS_STATE_DIR', work);
  vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
  vi.stubEnv('RESTART_ALERT_WEBHOOK', `http://127.0.0.1:${port}/alert`);
  await writeFile(join(work, 'prod.json'), JSON.stringify({
    apps: { 'prod-jin': { pid: 123, firstSeen: Date.now() - 120_000, failures: 0, lastRestart: null } },
    events: [],
  }));
  command.mockReset().mockImplementation((_file, args, _options, callback) => {
    if (args[0] === 'restart') healthy = true;
    callback(null, args[0] === 'pid' ? '123' : '', '');
  });
  const args = ['--env', 'prod', '--once', '--execute', '--watchdog', '--ecosystem', ecosystem];
  expect(await main(args)).toBe(false);
  expect(await main(args)).toBe(false);
  expect(await main(args)).toBe(false); // A restart is not an observed healthy HTTP response.
  expect(await main(args)).toBe(true);
  const restarts = command.mock.calls.filter(([, args]) => args[0] === 'restart');
  expect(restarts).toHaveLength(1);
  expect(restarts[0].slice(0, 2)).toEqual(['pm2', ['restart', 'prod-jin']]);
  expect(command.mock.calls.some(([, args]) => args.includes('dev-jin'))).toBe(false);
  expect(alerts).toBe(1);
  const state = JSON.parse(await readFile(join(work, 'prod.json'), 'utf8'));
  expect(state.apps['prod-jin'].failures).toBe(0);
  expect(state.events[0].delivered).toBe(true);
});

it('retains an alert when webhook delivery fails or throws', async () => {
  vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
  vi.stubEnv('RESTART_ALERT_WEBHOOK', 'https://watchdog.test/alert');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
  expect(await deliverWatchdog({ app: 'prod-jin' }, 7000)).toBe(false);
});

it.each(['dev', 'prod'])('skips a port-less %s kernel before any state or pm2 access', async environment => {
  work = await mkdtemp(join(tmpdir(), 'watchdog-portless-'));
  const ecosystem = join(work, 'ecosystem.cjs');
  const stateDirectory = join(work, 'liveness');
  await writeFile(ecosystem, `module.exports = { apps: [
    { name: '${environment}-jin', script: 'server.js' },
    { name: '${environment}-file-online', env: { PORT: 7001 } },
    { name: '${environment}-file-stopped', env: { PORT: 7002 } }
  ] };`);
  vi.stubEnv('IMAJIN_LIVENESS_STATE_DIR', stateDirectory);
  command.mockReset();
  const log = vi.spyOn(nodeConsole, 'info').mockImplementation(() => {});
  expect(await main(['--env', environment, '--once', '--execute', '--watchdog', '--ecosystem', ecosystem]))
    .toBe(true);
  expect(log).toHaveBeenCalledWith(JSON.stringify({
    service: 'liveness-probe', environment,
    event: 'watchdog.skipped', reason: 'Kernel HTTP port is not configured',
  }));
  expect(command).not.toHaveBeenCalled();
  await expect(access(stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reclaims only a dead lock and preserves the real target outbox and cooldown', async () => {
  const f = await inventoryFixture();
  const entry = { pid: 123, firstSeen: 1, failures: 2, lastRestart: 12345 };
  const event = { app: 'prod-jin', id: 'retain-me', outcome: 'requested' };
  await writeFile(f.statePath, JSON.stringify({ apps: { 'prod-jin': entry }, events: [{ event, delivered: false }] }));
  await writeFile(`${f.statePath}.lock`, '2147483647');
  expect(await main(f.args)).toBe(false); // No delivery credential: never discard a real receipt.
  const state = JSON.parse(await readFile(f.statePath, 'utf8'));
  expect(state.apps['prod-jin']).toEqual({ ...entry, failures: 0 });
  expect(state.events).toEqual([{ event, delivered: false }]);
  await expect(access(`${f.statePath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(`${f.statePath}.lock.recovery`)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['0', '', '-1', 'not-a-pid', '1.5'])('does not steal a lock with invalid owner %j', async owner => {
  work = await mkdtemp(join(tmpdir(), 'watchdog-lock-'));
  const path = join(work, 'prod.json.lock');
  await writeFile(path, owner);
  const kill = vi.spyOn(process, 'kill');
  await expect(acquireStateLock(path)).rejects.toThrow('Invalid lock owner');
  expect(kill).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(owner);
});

it('does not steal a live lock', async () => {
  const f = await inventoryFixture();
  await writeFile(`${f.statePath}.lock`, String(process.pid));
  await expect(main(f.args)).rejects.toThrow(`state lock ${JSON.stringify(`${f.statePath}.lock`)} (EEXIST)`);
  expect(command).not.toHaveBeenCalled();
  expect(await readFile(`${f.statePath}.lock`, 'utf8')).toBe(String(process.pid));
});

it('does not treat a denied owner lookup as a dead process', async () => {
  work = await mkdtemp(join(tmpdir(), 'watchdog-lock-permission-'));
  const path = join(work, 'prod.json.lock');
  await writeFile(path, '123');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Do not print process details'), { code: 'EPERM' });
  });
  await expect(acquireStateLock(path)).rejects.toMatchObject({ code: 'EPERM' });
  expect(await readFile(path, 'utf8')).toBe('123');
});

it('allows only one concurrent reclaimer to acquire an abandoned lock', async () => {
  work = await mkdtemp(join(tmpdir(), 'watchdog-lock-race-'));
  const path = join(work, 'prod.json.lock');
  await writeFile(path, '2147483647');
  const attempts = await Promise.allSettled([acquireStateLock(path), acquireStateLock(path)]);
  const winners = attempts.filter(result => result.status === 'fulfilled');
  expect(winners).toHaveLength(1);
  expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  await winners[0].value.close();
});

it.each([
  ['invalid-json', '{', 'state read/parse'],
  ['invalid-shape', '{"events":{}}', 'state shape'],
  ['null-state', 'null', 'state shape'],
])('names the state path for %s without discarding the source', async (_name, content, operation) => {
  const f = await inventoryFixture();
  await writeFile(f.statePath, content);
  await expect(main(f.args)).rejects.toThrow(`${operation} ${JSON.stringify(f.statePath)}`);
  expect(await readFile(f.statePath, 'utf8')).toBe(content);
  expect(command).not.toHaveBeenCalled();
});

it('names the state temporary path when a write is impossible', async () => {
  const f = await inventoryFixture();
  await mkdir(`${f.statePath}.tmp`);
  await expect(main(f.args)).rejects.toThrow(`state write ${JSON.stringify(`${f.statePath}.tmp`)}`);
});

it('names the directory when the state location is not a directory', async () => {
  const f = await inventoryFixture();
  await writeFile(f.statePath, 'not a directory');
  vi.stubEnv('IMAJIN_LIVENESS_STATE_DIR', join(f.statePath, 'nested'));
  await expect(main(f.args)).rejects.toThrow('state directory');
  expect(command).not.toHaveBeenCalled();
});

it('names a missing configuration path', async () => {
  work = await mkdtemp(join(tmpdir(), 'watchdog-config-'));
  const path = join(work, 'missing.cjs');
  await expect(main(['--env', 'prod', '--once', '--watchdog', '--ecosystem', path]))
    .rejects.toThrow(`configuration ${JSON.stringify(path)}`);
});

it('checks default tracked configuration without a custom ecosystem flag', async () => {
  work = await mkdtemp(join(tmpdir(), 'watchdog-default-'));
  vi.stubEnv('IMAJIN_LIVENESS_STATE_DIR', work);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  command.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, '123', ''));
  expect(await main(['--env', 'prod', '--once'])).toBe(true);
  expect(command.mock.calls.map(([, args]) => args)).toContainEqual(['pid', 'prod-jin']);
});

it('fails the watchdog on an unavailable PM2 lookup while checking other targets', async () => {
  const f = await inventoryFixture();
  const log = vi.spyOn(nodeConsole, 'error').mockImplementation(() => {});
  command.mockImplementationOnce((_file, _args, _options, callback) =>
    callback(Object.assign(new Error('Do not print subprocess details'), { code: 'ENOENT' })));
  expect(await main(f.args)).toBe(false);
  expect(f.requests).toEqual(['/health']);
  expect(log).toHaveBeenCalledWith('Liveness probe failed: PM2 pid "prod-jin" (ENOENT)');
  expect(command.mock.calls.some(([, args]) => args[0] === 'restart')).toBe(false);
});
