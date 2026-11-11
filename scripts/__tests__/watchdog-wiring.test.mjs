import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reproduceDatabaseWatchdog } from '../repro-db-watchdog.mjs';
import { deliverWatchdog, parseOptions } from '../../deploy/liveness-probe.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('the production watchdog runs the executable HTTP probe against the same ecosystem', async () => {
  const script = await readFile(new URL('../pm2-health-check.sh', import.meta.url), 'utf8');
  expect(script).toContain('node "$SCRIPT_DIR/../deploy/liveness-probe.mjs"');
  expect(script).toContain('--env "$SCOPE" --once --execute --watchdog --ecosystem "$ECOSYSTEM"');
  expect(script).toContain('if [[ "${PM2_HEALTH_LIVENESS:-1}" != "0" ]]; then');
  expect(script).toContain('if [[ "$check_status" -gt "$worst" ]]; then worst="$check_status"; fi');
});

it('reproduces three 503s across one-shot probes and exactly one app restart', async () => {
  expect(await reproduceDatabaseWatchdog()).toEqual({ failures: 3, restarts: 1, recovered: true });
});

it('accepts the watchdog invocation without requiring kernel credentials', () => {
  expect(parseOptions(['--env', 'prod', '--once', '--execute', '--watchdog', '--ecosystem', '/tmp/ecosystem.cjs']))
    .toEqual({ environment: 'prod', once: true, execute: true, watchdog: true, ecosystem: '/tmp/ecosystem.cjs' });
});

it.each([
  ['--watchdog'], ['--watchdog', '--execute'],
  ['--ecosystem'], ['--ecosystem', 'file.cjs'],
  ['--watchdog', '--once', '--execute', '--ecosystem'],
  ['--watchdog', '--once', '--execute', '--ecosystem', '--unknown'],
])('refuses invalid watchdog invocation %j', flags => {
  expect(() => parseOptions(['--env', 'prod', ...flags])).toThrow();
});

it('retains alerts if cron has neither webhook nor internal credential', async () => {
  for (const key of ['AUTH_INTERNAL_API_KEY', 'RESTART_ALERT_WEBHOOK', 'STATUS_ALERT_WEBHOOK']) vi.stubEnv(key, '');
  expect(await deliverWatchdog({}, 7000)).toBe(false);
});

it('permits a one-shot watchdog dry run without enabling restarts or delivery', () => {
  expect(parseOptions(['--env', 'prod', '--once', '--watchdog', '--ecosystem', '/tmp/ecosystem.cjs']))
    .toEqual({ environment: 'prod', once: true, execute: false, watchdog: true, ecosystem: '/tmp/ecosystem.cjs' });
});
