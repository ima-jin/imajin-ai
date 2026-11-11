import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
import { createProbe, targetsFromConfig, parseOptions, checkHealth, POLICY, runTicks } from '../../deploy/liveness-probe.mjs';
vi.mock('node:timers', () => ({
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
}));

const target = { app: 'prod-jin', port: 7000 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(overrides = {}, policy = {}) {
  let now = 0;
  const deps = {
    pid: vi.fn(async () => 123), check: vi.fn(async () => false),
    restart: vi.fn(async () => undefined), persist: vi.fn(async () => undefined),
    deliver: vi.fn(async () => true), now: () => now, ...overrides,
  };
  const probe = createProbe({}, deps, { ...POLICY, startupGraceMs: 0, ...policy });
  return { probe, deps, tick: () => probe.tick([target], { execute: true, kernelPort: 7000 }), time: value => { now = value; } };
}

describe('PM2 HTTP watchdog', () => {
  it('keeps the kernel and every declared kernel service protected in both inventories', () => {
    for (const env of ['dev', 'prod']) {
      const config = require(`../../deploy/ecosystem.${env}.config.js`);
      const targets = targetsFromConfig(config);
      expect(targets.map(value => value.app)).toEqual(
        config.apps.filter(value => value.name.endsWith('-jin') || value.env?.LIVENESS_PATH).map(value => value.name),
      );
      expect(targets.find(value => value.app === `${env}-jin`).port).toBe(env === 'prod' ? 7000 : 3000);
      expect(targets).toHaveLength(env === 'prod' ? 8 : 1);
      expect(targets.every(value => value.path === '/api/health?liveness=1')).toBe(true);
    }
    expect(targetsFromConfig({ apps: [{ name: 'dev-test', args: ['start', '-p', '3001'], env: { LIVENESS_PATH: '/health' } }] }))
      .toEqual([{ app: 'dev-test', port: 3001, path: '/health' }]);
  });

  it('selects by kernel cwd or declaration, not independent names or workspace membership', async () => {
    const config = { apps: [
      { name: 'prod-jin', cwd: '/repo/apps/kernel', env: { PORT: 7000, LIVENESS_PATH: '/' } },
      { name: 'prod-worker', cwd: '/repo/apps/kernel' },
      { name: 'prod-owned-listener', cwd: '/repo/apps/kernel', env: { PORT: 7001 } },
      { name: 'prod-declared', cwd: '/separate/repo', env: { PORT: 7400, LIVENESS_PATH: '/health' } },
      { name: 'prod-undeclared', cwd: '/separate/repo', env: { PORT: 7401 } },
      { name: 'prod-daemon', cwd: '/repo/apps/daemon', env: { PORT: 8013 } },
    ] };
    const targets = targetsFromConfig(config);
    expect(targets.map(value => value.app)).toEqual(['prod-jin', 'prod-owned-listener', 'prod-declared']);
    expect(targets[0].path).toBe('/api/health?liveness=1');
    const f = fixture({ check: vi.fn(async () => true) });
    for (let i = 0; i < 4; i++) await f.probe.tick(targets, { execute: true });
    expect(f.deps.pid.mock.calls.map(([app]) => app)).not.toContain('prod-undeclared');
    expect(f.deps.pid.mock.calls.map(([app]) => app)).not.toContain('prod-daemon');
    expect(Object.keys(f.probe.state.apps)).toEqual(targets.map(value => value.app));
    expect(f.deps.restart).not.toHaveBeenCalled();
    expect(f.probe.state.events).toEqual([]);
  });

  it.each(['', 'health', '//remote.test/health', 'https://remote.test/health', '/\\remote', '/health#fragment', '/health\n', 42, null])(
    'rejects an invalid declared path %j', path => {
      expect(() => targetsFromConfig({ apps: [{ name: 'prod-declared', env: { PORT: 7400, LIVENESS_PATH: path } }] }))
        .toThrow('Invalid liveness path');
    },
  );

  it.each([200, 204, 302, 404, 503])('checks a declared route without softening HTTP %s', async status => {
    const fetch = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal('fetch', fetch);
    expect(await checkHealth({ app: 'prod-declared', port: 7400, path: '/health' })).toBe(status < 300);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:7400/health');
  });

  it.each([
    { name: 'prod-test', env: { PORT: 0 } },
    { name: 'prod-test', env: { PORT: 65536 } },
    { name: 'prod-test', env: { PORT: 'oops' } },
    { name: 'prod-test', env: { PORT: 1.5 } },
    { name: 'unsafe;name', env: { PORT: 3000 } },
  ])('rejects invalid inventory instead of executing arbitrary PM2 names: %j', app => {
    expect(() => targetsFromConfig({ apps: [{ ...app, env: { ...app.env, LIVENESS_PATH: '/health' } }] }))
      .toThrow('Invalid liveness target');
  });

  it('restarts exactly the failed app on N consecutive misses and persists before restart', async () => {
    const f = fixture();
    await f.tick(); await f.tick();
    expect(f.deps.restart).not.toHaveBeenCalled();
    f.deps.restart.mockImplementation(async () => {
      expect(f.deps.persist).toHaveBeenCalled();
      expect(f.probe.state.events[0].event.outcome).toBe('requested');
    });
    await f.tick();
    expect(f.deps.restart).toHaveBeenCalledTimes(1);
    expect(f.deps.restart).toHaveBeenCalledWith('prod-jin');
    expect(f.deps.deliver).toHaveBeenCalledWith(expect.objectContaining({
      app: 'prod-jin', outcome: 'restarted', failures: 3,
    }), 7000);
    expect(f.probe.state.events[0].delivered).toBe(true);
  });

  it('resets a failure streak after success', async () => {
    const f = fixture();
    await f.tick(); await f.tick();
    f.deps.check.mockResolvedValueOnce(true);
    await f.tick(); await f.tick(); await f.tick();
    expect(f.deps.restart).not.toHaveBeenCalled();
  });

  it('does not restart during startup grace or a persistent restart cooldown', async () => {
    const f = fixture({}, { startupGraceMs: 90_000 });
    await f.tick(); await f.tick(); await f.tick();
    expect(f.deps.restart).not.toHaveBeenCalled();
    f.time(90_000); await f.tick();
    expect(f.deps.restart).toHaveBeenCalledTimes(1);
    f.time(100_000); await f.tick(); await f.tick(); await f.tick();
    expect(f.deps.restart).toHaveBeenCalledTimes(1);
    f.time(390_000); await f.tick();
    expect(f.deps.restart).toHaveBeenCalledTimes(2);
  });

  it('grants new PIDs startup grace without losing the existing cooldown', async () => {
    const f = fixture({}, { startupGraceMs: 90_000 });
    await f.tick(); f.time(100_000); await f.tick(); await f.tick();
    f.deps.pid.mockResolvedValue(456);
    await f.tick(); await f.tick(); await f.tick();
    expect(f.deps.restart).toHaveBeenCalledTimes(1);
    expect(f.probe.state.apps['prod-jin']).toMatchObject({ firstSeen: 100_000, lastRestart: 100_000 });
  });

  it('leaves intentionally stopped or absent PM2 apps stopped', async () => {
    const f = fixture({ pid: vi.fn(async () => 0) });
    await f.tick(); await f.tick(); await f.tick();
    expect(f.deps.check).not.toHaveBeenCalled();
    expect(f.deps.restart).not.toHaveBeenCalled();
  });

  it('continues checking other apps when one PM2 PID lookup is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fixture();
    f.deps.pid.mockRejectedValueOnce(new Error('pid query unavailable'));
    await f.probe.tick([target, { app: 'prod-chat', port: 7007 }]);
    expect(f.deps.check).toHaveBeenCalledTimes(1);
    expect(f.deps.check).toHaveBeenCalledWith({ app: 'prod-chat', port: 7007 });
  });
  it('dry-run never restarts or delivers a real ops receipt', async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) await f.probe.tick([target], { execute: false });
    expect(f.probe.state.apps['prod-jin'].failures).toBe(3);
    expect(f.deps.restart).not.toHaveBeenCalled();
    expect(f.deps.deliver).not.toHaveBeenCalled();
    expect(f.probe.state.events).toHaveLength(0);
  });

  it('retains undelivered events across watchdog restarts and redelivers after kernel recovery', async () => {
    const f = fixture({ deliver: vi.fn(async () => false) });
    await f.tick(); await f.tick(); await f.tick();
    const saved = JSON.parse(JSON.stringify(f.probe.state));
    expect(saved.events[0].delivered).toBe(false);
    const deliver = vi.fn(async () => true);
    const restarted = createProbe(saved, { ...f.deps, deliver });
    await restarted.tick([target], { execute: true, kernelPort: 7000 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(saved.events[0].delivered).toBe(true);
    expect(f.deps.restart).toHaveBeenCalledTimes(1);
  });

  it('records restart failure rather than claiming recovery', async () => {
    const f = fixture({ restart: vi.fn(async () => { throw new Error('stub failure'); }) });
    await f.tick(); await f.tick(); await f.tick();
    expect(f.probe.state.events[0].event.outcome).toBe('restart-failed');
    expect(f.deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'restart-failed' }), 7000);
  });

  it('recovers a real stalled HTTP stub without executing PM2 or touching a real app', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let healthy = false;
    const server = createServer((_req, res) => {
      if (healthy) { res.writeHead(200); res.end('{}'); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stub = { app: 'prod-stub', port: server.address().port };
    const restart = vi.fn(async () => { healthy = true; server.closeAllConnections(); });
    const events = [];
    const probe = createProbe({}, {
      pid: async () => 123, check: checkHealth, restart,
      deliver: async event => { events.push(event); return true; },
    }, { ...POLICY, startupGraceMs: 0, failures: 1 });
    try {
      await probe.tick([stub], { execute: true, kernelPort: stub.port });
      expect(restart).toHaveBeenCalledTimes(1);
      expect(restart).toHaveBeenCalledWith('prod-stub');
      expect(await checkHealth(stub)).toBe(true);
      expect(events).toEqual([expect.objectContaining({ app: 'prod-stub', outcome: 'restarted' })]);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }, 10_000);
});

describe('non-overlapping watchdog scheduling', () => {
  it('does not start another sweep until the first finishes, including during shutdown', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settle;
    const tick = vi.fn(() => new Promise(resolve => { settle = resolve; }));
    let finished = false;
    const pending = runTicks(tick, { once: false, signal: controller.signal })
      .then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    settle();
    await vi.advanceTimersByTimeAsync(POLICY.intervalMs);
    expect(tick).toHaveBeenCalledTimes(2);
    controller.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    settle();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops immediately when idle and clears the next scheduled sweep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const tick = vi.fn(async () => undefined);
    const pending = runTicks(tick, { once: false, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(tick).toHaveBeenCalledTimes(1);
  });
  it('runs exactly once in one-shot mode', async () => {
    const tick = vi.fn(async () => undefined);
    await runTicks(tick, { once: true, signal: new AbortController().signal });
    expect(tick).toHaveBeenCalledTimes(1);
  });
  it('does not start when already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const tick = vi.fn();
    await runTicks(tick, { once: false, signal: controller.signal });
    expect(tick).not.toHaveBeenCalled();
  });
  it('propagates a sweep failure for supervisor restart and removes the shutdown listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(runTicks(async () => { throw new Error('stub sweep failure'); }, {
      once: false, signal: controller.signal,
    })).rejects.toThrow('stub sweep failure');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('operator opt-in', () => {
  it('defaults to dry-run and accepts explicit one-shot execute', () => {
    expect(parseOptions(['--env', 'prod'])).toEqual({ environment: 'prod', once: false, execute: false });
    expect(parseOptions(['--env', 'dev', '--once', '--execute']))
      .toEqual({ environment: 'dev', once: true, execute: true });
  });
  it.each([[], ['--env'], ['--env', 'other'], ['--all'], ['--env', 'prod', '--execute', '--dry-run'], ['--env', 'prod', '--env', 'dev']])(
    'rejects unsafe or ambiguous arguments: %j', args => {
      expect(() => parseOptions(args)).toThrow();
    },
  );
});
