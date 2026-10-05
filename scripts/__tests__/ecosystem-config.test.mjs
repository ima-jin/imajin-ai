// ecosystem-config.test.mjs — shape guard for deploy/ecosystem.{dev,prod}.config.js (#2447).
//
// pm2 must exec the listener directly. `script: 'npm', args: 'start'` makes
// pm2 track the npm wrapper, so a restart kills npm but leaves the
// `sh -c next start` -> `next-server` grandchild holding the port (reparented
// to init), and the fresh pm2 copy crash-loops on EADDRINUSE. These tests keep
// that wrapper from creeping back in.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DEPLOY_DIR = fileURLToPath(new URL('../../deploy/', import.meta.url));

const NEXT_BIN = 'node_modules/next/dist/bin/next';

// Wrapper launchers that put a non-listening process between pm2 and the server.
const WRAPPER_SCRIPTS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'sh', 'bash']);

// Services from separate repos (/home/jin/<env>/imajin-<name>) whose start
// script isn't visible from this repo, so they can't be converted blind. Every
// other entry must exec directly. Shrink this list as each one is confirmed.
const EXTERNAL_WRAPPED = new Set([
  'dev-fixready',
  'dev-karaoke',
  'prod-fixready',
  'prod-karaoke',
  'prod-scorecard',
]);

// In-repo Next apps (`next start`) that must run via the next binary.
const NEXT_APPS = ['events', 'coffee', 'dykil', 'learn', 'market'];

function loadApps(env) {
  const apps = require(`${DEPLOY_DIR}ecosystem.${env}.config.js`).apps;
  expect(Array.isArray(apps)).toBe(true);
  return apps;
}

function portOf(app) {
  return String(app.env?.PORT ?? /(?:^|\s)-p\s+(\d+)/.exec(app.args ?? '')?.[1]);
}

for (const env of ['dev', 'prod']) {
  describe(`deploy/ecosystem.${env}.config.js (#2447)`, () => {
    const apps = loadApps(env);

    it('has unique app names and ports', () => {
      const names = apps.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
      const ports = apps.map(portOf).filter((p) => p !== 'undefined');
      // prod-jin shares nothing; every declared port is distinct.
      expect(new Set(ports).size).toBe(ports.length);
    });

    it('never wraps an in-repo service in npm/npx/pnpm/yarn/sh', () => {
      const wrapped = apps
        .filter((a) => WRAPPER_SCRIPTS.has(a.script) && !EXTERNAL_WRAPPED.has(a.name))
        .map((a) => a.name);
      expect(wrapped).toEqual([]);
    });

    it('only allowlists external wrappers that still exist', () => {
      const names = new Set(apps.map((a) => a.name));
      for (const app of apps) {
        if (EXTERNAL_WRAPPED.has(app.name)) {
          expect(WRAPPER_SCRIPTS.has(app.script)).toBe(true);
        }
      }
      // Allowlisted names for this env must actually be present (no stale entries).
      for (const name of EXTERNAL_WRAPPED) {
        if (name.startsWith(`${env}-`)) expect(names.has(name)).toBe(true);
      }
    });

    it('runs every Next app through the next binary on its own port', () => {
      for (const base of NEXT_APPS) {
        const app = apps.find((a) => a.name === `${env}-${base}`);
        if (!app) continue; // not every app is deployed in every env
        expect(app.script, app.name).toBe(NEXT_BIN);
        expect(app.args, app.name).toBe(`start -p ${app.env.PORT}`);
        expect(app.exec_mode, app.name).toBe('fork');
        expect(app.interpreter, app.name).toBe('node');
      }
    });

    it('keeps `next start` apps in sync with the -p port and PORT env', () => {
      for (const app of apps.filter((a) => a.script === NEXT_BIN)) {
        expect(app.args, app.name).toMatch(/^start -p \d+$/);
        expect(portOf(app), app.name).toBe(String(app.env.PORT));
      }
    });

    it('execs the kernel directly', () => {
      const kernel = apps.find((a) => a.name === `${env}-jin`);
      expect(kernel).toBeDefined();
      expect(kernel.script).toBe('server.js');
      expect(kernel.interpreter).toBe('node');
    });
  });
}

describe('deploy/ecosystem.dev.config.js corpus (#2447)', () => {
  it('runs dev-corpus under `node --import tsx`, not the npm/tsx wrapper', () => {
    const corpus = loadApps('dev').find((a) => a.name === 'dev-corpus');
    expect(corpus).toBeDefined();
    expect(corpus.script).toBe('src/index.ts');
    expect(corpus.interpreter).toBe('node');
    expect(corpus.node_args).toBe('--import tsx');
    expect(corpus.exec_mode).toBe('fork');
  });
});

// #2550: the kernel's scheduled jobs only run if this process is declared in the
// ecosystem file that `pm2 startOrReload` / the deploy workflows apply.
for (const env of ['dev', 'prod']) {
  describe(`deploy/ecosystem.${env}.config.js kernel cron scheduler (#2550)`, () => {
    const apps = loadApps(env);
    const kernel = apps.find((a) => a.name === `${env}-jin`);
    const cron = apps.find((a) => a.name === `${env}-kernel-cron`);

    it(`declares ${env}-kernel-cron next to the kernel`, () => {
      expect(cron).toBeDefined();
      expect(apps.indexOf(cron)).toBe(apps.indexOf(kernel) + 1);
    });

    it('execs the scheduler directly under node --import tsx (never npm/sh)', () => {
      expect(cron.script).toBe('src/cron/scheduler.ts');
      expect(WRAPPER_SCRIPTS.has(cron.script)).toBe(false);
      expect(cron.interpreter).toBe('node');
      expect(cron.exec_mode).toBe('fork');
      expect(cron.node_args).toContain('--import tsx');
    });

    it("runs in the kernel's directory and loads the kernel's .env.local (vault bootstrap identity) via --env-file", () => {
      expect(cron.cwd).toBe(kernel.cwd);
      expect(cron.node_args).toContain(`--env-file=${kernel.cwd}/.env.local`);
    });

    it("calls the kernel's own loopback port and never carries the secret in the config", () => {
      const port = portOf(kernel);
      expect(cron.env.CRON_BASE_URL).toBe(`http://127.0.0.1:${port}`);
      expect(JSON.stringify(cron)).not.toMatch(/CRON_SECRET/);
      expect(cron.env.PORT).toBeUndefined(); // no listener of its own
    });

    it('has the same restart limits as the other apps', () => {
      expect(cron.max_restarts).toBe(10);
      expect(cron.min_uptime).toBe('20s');
    });
  });
}
