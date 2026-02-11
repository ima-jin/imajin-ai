# imajin-ai

Monorepo for Imajin web projects.

## Apps

| App | Domain | Status |
|-----|--------|--------|
| [dykil](./apps/dykil) | dykil.imajin.ai | 🟡 Planning |
| [learn](./apps/learn) | learn.imajin.ai | 🟡 Planning |
| [fixready](./apps/fixready) | fixready.imajin.ai | 🔴 Not Started |
| [karaoke](./apps/karaoke) | karaoke.imajin.ai | 🔴 Not Started |

## Packages

| Package | Description |
|---------|-------------|
| [@imajin/ui](./packages/ui) | Shared UI components |
| [@imajin/db](./packages/db) | Shared Prisma + Postgres |
| [@imajin/config](./packages/config) | Shared configs |

## Setup

```bash
pnpm install
```

## Development

```bash
# Run all apps
pnpm dev

# Run specific app
pnpm --filter @imajin/dykil dev
```

## Structure

```
imajin-ai/
├── apps/
│   ├── dykil/         # Don't You Know I'm Local
│   ├── learn/         # AI training courses
│   ├── fixready/      # Consulting project
│   └── karaoke/       # Consulting project
├── packages/
│   ├── ui/            # Shared components
│   ├── db/            # Database client
│   └── config/        # Shared configs
└── turbo.json
```
