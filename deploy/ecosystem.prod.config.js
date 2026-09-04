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
      "name": "prod-jin",
      "cwd": "/home/jin/prod/imajin-ai/apps/kernel",
      "script": "server.js",
      "args": "-p 7000",
      "interpreter": "node",
      "node_args": "--env-file=/home/jin/prod/imajin-ai/apps/kernel/.env.local",
      "env": {
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-auth",
      "cwd": "/home/jin/prod/imajin-ai/apps/auth",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7001,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-registry",
      "cwd": "/home/jin/prod/imajin-ai/apps/registry",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7002,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-connections",
      "cwd": "/home/jin/prod/imajin-ai/apps/connections",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7003,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-pay",
      "cwd": "/home/jin/prod/imajin-ai/apps/pay",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7004,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-profile",
      "cwd": "/home/jin/prod/imajin-ai/apps/profile",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7005,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-events",
      "cwd": "/home/jin/prod/imajin-ai/apps/events",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7006,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-chat",
      "cwd": "/home/jin/prod/imajin-ai/apps/chat",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7007,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-media",
      "cwd": "/home/jin/prod/imajin-ai/apps/media",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7009,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-coffee",
      "cwd": "/home/jin/prod/imajin-ai/apps/coffee",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7100,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-dykil",
      "cwd": "/home/jin/prod/imajin-ai/apps/dykil",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7101,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-links",
      "cwd": "/home/jin/prod/imajin-ai/apps/links",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7102,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-learn",
      "cwd": "/home/jin/prod/imajin-ai/apps/learn",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7103,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    },
    {
      "name": "prod-market",
      "cwd": "/home/jin/prod/imajin-ai/apps/market",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 7104,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
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
      "min_uptime": "20s"
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
      "min_uptime": "20s"
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
      "min_uptime": "20s"
    },
    {
      // corpus is an internal-only daemon (packages/config/src/services.ts),
      // not a subdomain-routed web app, so it doesn't follow the 3xxx/7xxx
      // dev/prod port convention. 8003 is its one canonical port — the same
      // value kernel's CORPUS_SERVICE_URL default already points at
      // (apps/kernel/.env.example, apps/kernel/src/lib/kernel/corpus-client.ts)
      // — used identically in both environments (#1748, #1741, #1726).
      "name": "prod-corpus",
      "cwd": "/home/jin/prod/imajin-ai/apps/corpus",
      "script": "npm",
      "args": "start",
      "env": {
        "PORT": 8003,
        "NODE_ENV": "production"
      },
      "max_restarts": 10,
      "min_uptime": "20s"
    }
  ]
};
