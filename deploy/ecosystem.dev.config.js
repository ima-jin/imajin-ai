module.exports = {
  "apps": [
    {
      "name": "dev-jin",
      "cwd": "/home/jin/dev/imajin-ai/apps/kernel",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3000,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-events",
      "cwd": "/home/jin/dev/imajin-ai/apps/events",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3006,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-coffee",
      "cwd": "/home/jin/dev/imajin-ai/apps/coffee",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3100,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-dykil",
      "cwd": "/home/jin/dev/imajin-ai/apps/dykil",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3101,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-links",
      "cwd": "/home/jin/dev/imajin-ai/apps/links",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3102,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-learn",
      "cwd": "/home/jin/dev/imajin-ai/apps/learn",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3103,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-market",
      "cwd": "/home/jin/dev/imajin-ai/apps/market",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3104,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-fixready",
      "cwd": "/home/jin/dev/imajin-fixready",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3400,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "dev-karaoke",
      "cwd": "/home/jin/dev/imajin-karaoke",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 3401,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
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
      // CORPUS_DID_PRIVATE_KEY, AUTH_SERVICE_URL, ATTESTATION_INTERNAL_API_KEY.
      // Deliberately NOT listed in this file's "env" block, matching the
      // existing CORPUS_KERNEL_PUBLIC_KEY precedent (#2024) — this config is
      // version-controlled, so real secret values belong in the process
      // environment / .env.local on the host, never here.
      "name": "dev-corpus",
      "cwd": "/home/jin/dev/imajin-ai/apps/corpus",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 8013,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    }
  ]
};
