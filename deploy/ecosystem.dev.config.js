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
      // See ecosystem.prod.config.js's prod-corpus comment: corpus is an
      // internal-only daemon, not on the 3xxx/7xxx web-app port convention,
      // so dev and prod share the same canonical port (8003).
      "name": "dev-corpus",
      "cwd": "/home/jin/dev/imajin-ai/apps/corpus",
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
