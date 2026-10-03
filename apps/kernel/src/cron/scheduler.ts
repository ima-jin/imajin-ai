/**
 * Entry point for the kernel cron scheduler process (#2550).
 *
 * Run directly by pm2 (`prod-kernel-cron` / `dev-kernel-cron` in
 * deploy/ecosystem.{prod,dev}.config.js) under `node --import tsx`, with the
 * kernel's `.env.local` loaded via `--env-file` so it sees CRON_SECRET. Never
 * wrap it in `npm start` (#2547): pm2 must track the real process.
 *
 * All behaviour lives in ./runner.ts; this file only wires signals and turns a
 * config error into a loud non-zero exit.
 */
import { startScheduler } from './runner';
import { KERNEL_CRON_MANIFEST } from './schedule';

try {
  const scheduler = startScheduler(KERNEL_CRON_MANIFEST);
  const shutdown = () => {
    scheduler.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (err) {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'cron.scheduler-failed-to-start',
      error: err instanceof Error ? err.message : String(err),
    })}\n`,
  );
  process.exit(1);
}
