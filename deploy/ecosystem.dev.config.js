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
// fixready / karaoke / scorecard live in separate repos but are plain Next 14
// apps (`"start": "next start"`, no custom server), so they exec the next
// binary directly like every other app (#2573).
module.exports = {
  "apps": [
    {
      // VAULT_PATH (#2357): dev must never read/write prod-jin's vault file.
      // A literal leading `~` is expanded to the process's home directory at
      // runtime (apps/kernel/src/lib/vault/vault-path.ts) — this config is
      // version-controlled and can't embed a concrete home directory.
      "name": "dev-jin",
      "cwd": "/home/jin/dev/imajin-ai/apps/kernel",
      "script": "server.js",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3000,
        "NODE_ENV": "production",
        "VAULT_PATH": "~/.imajin/vault.dev.json"
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
      // itself, one structured JSON log line per run (`pm2 logs dev-kernel-cron`).
      // Last run + outcome per job: GET /api/admin/cron-status.
      //
      // Exec'd directly under `node --import tsx` (the dev-corpus pattern), NOT
      // via `npm start` (#2447/#2547): the pm2 pid is the process.
      // `--env-file` loads the kernel's untracked .env.local (dev-jin's own
      // server.js loads the same file) for the scheduler's vault bootstrap
      // identity (KERNEL_CRON_VAULT_BOOTSTRAP_DID/_PRIVATE_KEY), minted by the
      // deploy's provisioning step. The bearer secret is NOT in that file: it is
      // a vault grant the scheduler fetches at boot with loadFromVault and keeps
      // in memory only. Node EXITS if the file is missing, and the scheduler
      // exits non-zero if it cannot fetch the grant (the error points at the
      // vault), so a misconfigured host crash-loops visibly instead of running
      // nothing. CRON_BASE_URL must be loopback and match dev-jin's port above.
      // The deploy workflow starts this app even when pm2 has never seen it (see
      // deploy-dev.yml "Restart dev services").
      "name": "dev-kernel-cron",
      "cwd": "/home/jin/dev/imajin-ai/apps/kernel",
      "script": "src/cron/scheduler.ts",
      "interpreter": "node",
      "node_args": "--env-file=/home/jin/dev/imajin-ai/apps/kernel/.env.local --import tsx",
      "exec_mode": "fork",
      "env": {
        "NODE_ENV": "production",
        "CRON_BASE_URL": "http://127.0.0.1:3000"
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
      "name": "dev-events",
      "cwd": "/home/jin/dev/imajin-ai/apps/events",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 3006",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3006,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "dev-coffee",
      "cwd": "/home/jin/dev/imajin-ai/apps/coffee",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 3100",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3100,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "dev-dykil",
      "cwd": "/home/jin/dev/imajin-ai/apps/dykil",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 3101",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3101,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "dev-learn",
      "cwd": "/home/jin/dev/imajin-ai/apps/learn",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 3103",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3103,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "dev-market",
      "cwd": "/home/jin/dev/imajin-ai/apps/market",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 3104",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3104,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "dev-fixready",
      "cwd": "/home/jin/dev/imajin-fixready",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 3400",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3400,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      "name": "dev-karaoke",
      "cwd": "/home/jin/dev/imajin-karaoke",
      "script": "node_modules/next/dist/bin/next",
      "args": "start -p 3401",
      "interpreter": "node",
      "exec_mode": "fork",
      "env": {
        "PORT": 3401,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    },
    {
      // See ecosystem.prod.config.js's corpus comment: corpus is an
      // internal-only daemon, not on the 3xxx/7xxx web-app port convention.
      // dev-jin and prod-jin (and every other dev-*/prod-* pair) run side by
      // side on the same host, so dev-corpus can't reuse prod-corpus's 8003 —
      // that would be a straight port collision, not a shared value. 8013
      // has no other precedent to follow (corpus is the only 8xxx service),
      // so it's just "8003 + 10" to keep it visually next to its prod pair.
      //
      // Per #2232 (multi-host deploy) prod-corpus was removed from
      // ecosystem.prod.config.js — corpus now runs on gx10 in prod, not the
      // ProLiant. dev-corpus stays here deliberately: corpus still runs in
      // dev on this host today. scripts/check-env.ts (#2246) derives each
      // env's deploy targets from these files' `cwd` entries, so keeping
      // this entry is what keeps a missing apps/corpus/.env.local a hard
      // error in dev (as it is today) while it's a warning in prod.
      //
      // Secrets (#1750, apps/corpus/.env.example): CORPUS_DID,
      // CORPUS_DID_PRIVATE_KEY, AUTH_SERVICE_URL (ATTESTATION_INTERNAL_API_KEY
      // is vault-sourced via the CORPUS_VAULT_BOOTSTRAP_* identity, #2353).
      // Deliberately NOT listed in this file's "env" block, matching the
      // existing CORPUS_KERNEL_PUBLIC_KEY precedent (#2024) — this config is
      // version-controlled, so real secret values belong in the process
      // environment / .env.local on the host, never here.
      "name": "dev-corpus",
      "cwd": "/home/jin/dev/imajin-ai/apps/corpus",
      "script": "src/index.ts",
      "interpreter": "node",
      "node_args": "--import tsx",
      "exec_mode": "fork",
      "env": {
        "PORT": 8013,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s",
      "kill_timeout": 15000
    }
  ]
};
