import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout, clearTimeout } from 'node:timers';
import process from 'node:process';
import console from 'node:console';
import transport from '../packages/auth/src/internal-fetch.cjs';
const { internalFetch } = transport;
const exec = promisify(execFile);

const POLICY = Object.freeze({
  intervalMs: 15_000, timeoutMs: 5_000, failures: 3,
  startupGraceMs: 90_000, cooldownMs: 300_000,
});

function sequential(items, operation) {
  return items.reduce((pending, item) => pending.then(() => operation(item)), Promise.resolve());
}

/** Retired targets cannot keep counters or an undeliverable pending outbox. */
function pruneState(state, targets) {
  const names = new Set(targets.map(target => target.app));
  state.apps = Object.fromEntries(Object.entries(state.apps ?? {}).filter(([name]) => names.has(name)));
  state.events = (state.events ?? []).filter(receipt => receipt.delivered || names.has(receipt.event.app));
}

/** One sweep at a time, with no retained recursive promise chain. */
function runTicks(tick, { once, signal, intervalMs = POLICY.intervalMs }) {
  if (signal.aborted) return Promise.resolve();
  let timer;
  let running = false;
  let onAbort;
  const finished = new Promise((resolve, reject) => {
    const next = () => {
      running = true;
      Promise.resolve().then(tick).then(() => {
        running = false;
        if (once || signal.aborted) resolve();
        else timer = setTimeout(next, intervalMs);
      }, reject);
    };
    onAbort = () => {
      clearTimeout(timer);
      if (!running) resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    next();
  });
  return finished.finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });
}

/** Configs are the inventory; never read `pm2 jlist` (it exposes secrets). */
function targetsFromConfig(config) {
  const kernel = config.apps.find(app => app.name?.endsWith('-jin'));
  return config.apps.flatMap((app) => {
    const kernelOwned = app === kernel || (kernel?.cwd && app.cwd === kernel.cwd);
    const defaultPath = kernelOwned ? '/api/health?liveness=1' : undefined;
    const path = app.env?.LIVENESS_PATH === undefined ? defaultPath : app.env.LIVENESS_PATH;
    if (path === undefined) return [];
    if (typeof path !== 'string' || !/^\/(?!\/)[^\s\\#]*$/.test(path)
      || new URL(path, 'http://localhost').origin !== 'http://localhost') {
      throw new Error('Invalid liveness path');
    }
    const args = Array.isArray(app.args) ? app.args.join(' ') : app.args ?? '';
    const match = /(?:^|\s)-p\s+(\d+)(?:\s|$)/.exec(args);
    const configuredPort = app.env?.PORT ?? match?.[1];
    // Cron/scheduler processes deliberately have no HTTP listener.
    if (configuredPort === undefined) return [];
    const port = Number(configuredPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^(dev|prod)-[a-z0-9-]{1,60}$/.test(app.name)) {
      throw new Error('Invalid liveness target');
    }
    return [{ app: app.name, port, path }];
  });
}

async function checkHealth(target) {
  try {
    const response = await internalFetch(
      `http://127.0.0.1:${target.port}${target.path ?? '/api/health?liveness=1'}`,
      { redirect: 'manual' }, POLICY.timeoutMs,
    );
    return response.ok;
  } catch { return false; }
}

async function pid(app) {
  const { stdout } = await exec('pm2', ['pid', app], { timeout: 5_000, maxBuffer: 4096 });
  const value = Number(stdout.trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid PM2 pid');
  return value;
}

async function restart(app) {
  // No shell interpolation, no --update-env, and no broad/all-app restart.
  await exec('pm2', ['restart', app], { timeout: 20_000, maxBuffer: 65_536 });
}

async function deliver(event, kernelPort) {
  const key = process.env.AUTH_INTERNAL_API_KEY;
  if (!key) return false;
  try {
    const response = await internalFetch(`http://127.0.0.1:${kernelPort}/jin/api/internal/ops-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify(event),
      redirect: 'error',
    });
    return response.ok;
  } catch { return false; }
}

/** Cron inherits the existing watchdog webhook, not the kernel's secrets. */
async function deliverWatchdog(event, kernelPort) {
  if (process.env.AUTH_INTERNAL_API_KEY) return deliver(event, kernelPort);
  const webhook = process.env.RESTART_ALERT_WEBHOOK || process.env.STATUS_ALERT_WEBHOOK;
  if (!webhook) return false; // Durable outbox is retained for a later delivery.
  try {
    const response = await internalFetch(webhook, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `HTTP liveness: ${event.app} ${event.outcome}`, ...event }),
    });
    return response.ok;
  } catch { return false; }
}

/** Sequential ticks; each app has independent counters and restart cooldown. */
function createProbe(state, dependencies = {}, policy = POLICY) {
  const deps = {
    check: checkHealth, pid, restart, deliver,
    persist: async () => undefined, now: Date.now, ...dependencies,
  };
  state.apps ??= {};
  state.events ??= [];

  async function checkTarget(target, execute) {
    let currentPid;
    try { currentPid = await deps.pid(target.app); }
    catch {
      console.error(JSON.stringify({ service: 'liveness-probe', app: target.app, error: 'PM2_PID_UNAVAILABLE' }));
      return;
    }
    const previous = state.apps[target.app];
    if (previous?.pid !== currentPid) {
      state.apps[target.app] = {
        pid: currentPid, firstSeen: deps.now(), failures: 0,
        lastRestart: previous?.lastRestart ?? null,
      };
    }
    const entry = state.apps[target.app];
    // A deliberately stopped/missing app is not a wedged online listener.
    if (!currentPid) { entry.failures = 0; return; }
    if (await deps.check(target)) { entry.failures = 0; return; }
    entry.failures = Math.min(entry.failures + 1, policy.failures);
    const now = deps.now();
    if (entry.failures < policy.failures || now - entry.firstSeen < policy.startupGraceMs
      || (entry.lastRestart !== null && now - entry.lastRestart < policy.cooldownMs)) return;
    if (!execute) return; // Dry-run: count failures, but no restart or real receipt.

    const event = {
      id: randomUUID(), app: target.app, port: target.port, outcome: 'requested',
      failures: entry.failures, at: new Date(now).toISOString(),
    };
    state.events.push({ event, delivered: false });
    entry.lastRestart = now;
    entry.failures = 0;
    // Persist BEFORE restarting, so process/host death cannot erase the attempt.
    await deps.persist(state);
    try { await deps.restart(target.app); event.outcome = 'restarted'; }
    catch { event.outcome = 'restart-failed'; }
    console.info(JSON.stringify({ service: 'liveness-probe', ...event }));
    await deps.persist(state);
  }

  return {
    state,
    async tick(targets, { execute = false, kernelPort } = {}) {
      // Serial state writes, parallelism isn't needed for this small inventory.
      await sequential(targets, (target) => checkTarget(target, execute));
      if (execute) {
        // A dead kernel must not make a long outbox starve the next health tick.
        const pending = state.events.filter((receipt) => !receipt.delivered).slice(0, 5);
        await sequential(pending, async (receipt) => {
          if (await deps.deliver(receipt.event, kernelPort)) {
            receipt.delivered = true;
            await deps.persist(state);
          }
        });
      }
      await deps.persist(state);
    },
  };
}

function watchdogOptions(args) {
  const watchdog = args.includes('--watchdog');
  const hasEcosystem = args.includes('--ecosystem');
  const ecosystem = hasEcosystem ? args[args.indexOf('--ecosystem') + 1] : undefined;
  if (watchdog && !args.includes('--once')) {
    throw new Error('Watchdog requires --once');
  }
  if (hasEcosystem && (!watchdog || !ecosystem || ecosystem.startsWith('--'))) {
    throw new Error('Watchdog requires a valid ecosystem path');
  }
  return { ...(watchdog ? { watchdog: true } : {}), ...(ecosystem ? { ecosystem } : {}) };
}

function parseOptions(args) {
  const allowed = new Set(['--env', '--once', '--execute', '--dry-run', '--watchdog', '--ecosystem']);
  const flags = args.filter((arg) => allowed.has(arg));
  if (new Set(flags).size !== flags.length) throw new Error('Duplicate probe argument');
  if (args.some((arg, index) => !allowed.has(arg) && !['--env', '--ecosystem'].includes(args[index - 1]))) {
    throw new Error('Unknown probe argument');
  }
  const environment = args[args.indexOf('--env') + 1];
  if (!args.includes('--env') || !['dev', 'prod'].includes(environment)
    || (args.includes('--execute') && args.includes('--dry-run'))) {
    throw new Error('Use --env dev|prod and either --execute or --dry-run');
  }
  return {
    environment, once: args.includes('--once'), execute: args.includes('--execute'),
    ...watchdogOptions(args),
  };
}

async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const config = await import(options.ecosystem
    ? pathToFileURL(resolve(options.ecosystem)).href : `./ecosystem.${options.environment}.config.js`);
  const targets = targetsFromConfig(config.default).filter(target => target.app.startsWith(`${options.environment}-`));
  const kernelPort = targets.find((target) => target.app === `${options.environment}-jin`)?.port;
  if (options.watchdog && !kernelPort) {
    console.info(JSON.stringify({
      service: 'liveness-probe', environment: options.environment,
      event: 'watchdog.skipped', reason: 'Kernel HTTP port is not configured',
    }));
    return true;
  }
  if (!kernelPort) throw new Error('Kernel target is required');
  if (options.execute && !options.watchdog && !process.env.AUTH_INTERNAL_API_KEY) throw new Error('Ops-event credential is required');
  const path = join(process.env.IMAJIN_LIVENESS_STATE_DIR || join(homedir(), '.imajin', 'liveness'), `${options.environment}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(`${path}.lock`, 'wx', 0o600);
  const stop = new globalThis.AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await lock.writeFile(String(process.pid));
    let state;
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never silently discard counters/outbox.
      state = {};
    }
    pruneState(state, targets);
    const persist = async (value) => {
      await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    };
    const probe = createProbe(state, {
      persist, ...(options.watchdog ? { deliver: deliverWatchdog } : {}),
    });
    await runTicks(async () => {
      await probe.tick(targets, { ...options, kernelPort });
      console.info(JSON.stringify({
        service: 'liveness-probe', environment: options.environment,
        execute: options.execute, apps: state.apps,
        pendingEvents: state.events.filter((receipt) => !receipt.delivered).length,
      }));
    }, { once: options.once, signal: stop.signal });
    return !options.watchdog || (
      !Object.values(state.apps).some(app => app.failures > 0)
      && !state.events.some(receipt => !receipt.delivered)
    );
  } finally {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await lock.close();
    await unlink(`${path}.lock`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { if (await main() === false) process.exitCode = 1; }
  catch {
    console.error('Liveness probe failed; inspect configuration, PM2 availability and state-file permissions');
    process.exitCode = 1;
  }
}
export { POLICY, targetsFromConfig, createProbe, checkHealth, parseOptions, runTicks, main, deliverWatchdog };
