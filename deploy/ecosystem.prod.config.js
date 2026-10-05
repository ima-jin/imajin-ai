// pm2 must exec the listener directly (#2447). Never use `script: "npm"` /
// `args: "start"` for an app we own: pm2 tracks the npm wrapper, so on restart
// it kills npm while the `sh -c next start` -> `next-server` grandchildren
// survive, get reparented to init and keep the port bound. The fresh pm2 copy
// then crash-loops on EADDRINUSE while the orphan serves traffic. Instead:
//   - Next apps:  script node_modules/next/dist/bin/next, args "start -p <port>"
//   - kernel:     script server.js (the custom Next server)
//   - corpus:     script src/index.ts under `node --import tsx`
// so the pm2-managed pid *is* the listener. scripts/assert-pm2-listeners.sh
// verifies this after every deploy restart.
//
// Every app sets an explicit `kill_timeout` (#2547) so pm2 waits long enough
// for a clean shutdown before SIGKILL; scripts/check-pm2-restarts.sh alerts on
// restart-count growth so a crash loop cannot stay silent.
//
// fixready / karaoke / scorecard live in separate repos whose start scripts
// are not visible from here; they keep `npm start` until each is confirmed and
// converted (tracked in the allowlist in scripts/__tests__/ecosystem-config.test.mjs).
module.exports = {
  "apps": [
    {
      // prod-jin runs the Next standalone server directly (`node server.js`),
      // which does NOT auto-load .env.local the way `next dev` / `next start` do.
      // The process therefore only ever saw AUTH_PRIVATE_KEY when someone started
      // it by hand with the env exported, so the next `pm2 restart` silently
      // dropped it and the kernel lost the ability to read every sealed vault
      // entry (#1520).
      //
      // `--env-file` (Node >= 20.6) loads it deterministically, making the env a
      // property of this config rather than of whoever ran the last restart. It is
      // the same mechanism the kernel's own `dev` script uses. Secrets stay in the
      // untracked .env.local on the server; only the path is version-controlled.
      //
      // Node EXITS if the file is missing, which is deliberate here: a prod-jin
      // that cannot load its env should crash loudly under pm2 rather than come
      // back up with the wrong signing identity. Shell env still takes precedence
      // over file values, so `env` below continues to win.
      // VAULT_PATH (#2357): prod must never read/write dev-jin's vault file.
      // Set here (pm2 env, not .env.local) so it wins regardless of what the
      // env-file below carries — same reasoning as NODE_ENV above. A literal
      // leading `~` is expanded to the process's home directory at runtime
      // (apps/kernel/src/lib/vault/vault-path.ts).
      "name": "prod-jin",
      "cwd": "/home/jin/prod/imajin-ai/apps/kernel",
      "script": "server.js",
      "args": "-p 7000",
      "interpreter": "node",
      "node_args": "--env-file=/home/jin/prod/imajin-ai/apps/kernel/.env.local",
      "env": {
        "NODE_ENV": "production",
        "VAULT_PATH": "~/.imajin/vault.prod.json"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      // Kernel cron scheduler (#2550). We don't deploy on Vercel, so the
      // kernel's scheduled jobs (apps/kernel/src/cron/schedule.ts) only run if
      // something on this host calls them. This process reads that manifest and
      // calls each /api/cron/* route on loopback with
      // `Authorization: Bearer <cron secret>`, never overlapping a job with
      // itself, one structured JSON log line per run (`pm2 logs prod-kernel-cron`).
      // Last run + outcome per job: GET /api/admin/cron-status.
      //
      // Exec'd directly under `node --import tsx` (the dev-corpus pattern), NOT
      // via `npm start` (#2447/#2547): the pm2 pid is the process.
      // `--env-file` loads the kernel's untracked .env.local (prod-jin's own
      // server.js loads the same file) for the scheduler's vault bootstrap
      // identity (KERNEL_CRON_VAULT_BOOTSTRAP_DID/_PRIVATE_KEY), minted by the
      // deploy's provisioning step. The bearer secret is NOT in that file: it is
      // a vault grant the scheduler fetches at boot with loadFromVault and keeps
      // in memory only. Node EXITS if the file is missing, and the scheduler
      // exits non-zero if it cannot fetch the grant (the error points at the
      // vault), so a misconfigured host crash-loops visibly instead of running
      // nothing. CRON_BASE_URL must be loopback and match prod-jin's port above.
      // The deploy workflow starts this app even when pm2 has never seen it (see
      // deploy-prod.yml "Restart prod services").
      "name": "prod-kernel-cron",
      "cwd": "/home/jin/prod/imajin-ai/apps/kernel",
      "script": "src/cron/scheduler.ts",
      "interpreter": "node",
      "node_args": "--env-file=/home/jin/prod/imajin-ai/apps/kernel/.env.local --import tsx",
      "exec_mode": "fork",
      "env": {
        "NODE_ENV": "production",
        "CRON_BASE_URL": "http://127.0.0.1:7000"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      // Long-running ticker (no listener, autorestart on), not a one-shot: its
      // SIGTERM handler stops the ticker and exits 0 immediately, so a clean
      // stop is near-instant. We still set the same explicit kill_timeout as
      // every other app (#2547) as a cap for an in-flight /api/cron/* call.
      "kill_timeout": 15000
    },
    {
      "name": "prod-auth",
      "cwd": "/home/jin/prod/imajin-ai/apps/auth",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7001",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7001,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-registry",
      "cwd": "/home/jin/prod/imajin-ai/apps/registry",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7002",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7002,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-connections",
      "cwd": "/home/jin/prod/imajin-ai/apps/connections",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7003",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7003,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-pay",
      "cwd": "/home/jin/prod/imajin-ai/apps/pay",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7004",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7004,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-profile",
      "cwd": "/home/jin/prod/imajin-ai/apps/profile",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7005",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7005,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-events",
      "cwd": "/home/jin/prod/imajin-ai/apps/events",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7006",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7006,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-chat",
      "cwd": "/home/jin/prod/imajin-ai/apps/chat",
      "script": "server.js",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7007,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-media",
      "cwd": "/home/jin/prod/imajin-ai/apps/media",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7009",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7009,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-coffee",
      "cwd": "/home/jin/prod/imajin-ai/apps/coffee",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7100",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7100,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-dykil",
      "cwd": "/home/jin/prod/imajin-ai/apps/dykil",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7101",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7101,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-learn",
      "cwd": "/home/jin/prod/imajin-ai/apps/learn",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7103",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7103,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-market",
      "cwd": "/home/jin/prod/imajin-ai/apps/market",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 7104",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 7104,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-fixready",
      "cwd": "/home/jin/prod/imajin-fixready",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7400,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-karaoke",
      "cwd": "/home/jin/prod/imajin-karaoke",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7401,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "prod-scorecard",
      "cwd": "/home/jin/prod/imajin-scorecard",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7402,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    }
    // corpus is deliberately NOT listed here. Per #2232 (multi-host deploy),
    // corpus runs on gx10, not this host (the ProLiant) — Ryan decided
    // (2026-09-22) that corpus is out of the prod deploy loop for this pm2
    // config. See ecosystem.dev.config.js's dev-corpus entry, which stays:
    // corpus still runs in dev on this host today.
    //
    // scripts/check-env.ts (#2246) reads each env's deploy targets from this
    // file's `cwd` entries, so removing this entry also makes a missing
    // apps/corpus/.env.local a warning rather than a hard error when running
    // `check-env --env prod` — do not re-add a `prod-corpus` block here just
    // to silence that warning; add it back only once corpus is actually
    // deployed to this host again.
  ]
};
