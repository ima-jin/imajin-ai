import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nodeConsole from 'node:console';
import { afterEach, expect, it, vi } from 'vitest';

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('node:child_process', () => {
  const execFile = (...args) => command(...args);
  execFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => new Promise((resolve, reject) => {
    command(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  return { execFile };
});
import { main, deliverWatchdog } from '../../deploy/liveness-probe.mjs';

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
    { name: 'prod-jin', env: { PORT: ${port} } },
    { name: 'dev-jin', env: { PORT: ${port} } },
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
  expect(await main(args)).toBe(true);
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
