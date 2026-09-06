# @imajin/kernel

The kernel — the Next.js application implementing the six primitives (Attestation, Communication, Attribution, Settlement, Discovery, Revocation) and the rails that serve them (auth, pay, registry, connections, chat, media, bus). This is not a third-party app; it's what a node operator runs.

Coffee, dykil, links, learn, events, and market currently run inside this same monorepo as separate services pending extraction behind the registered-app contract ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)) — see the [root README](../../README.md) for the kernel/app boundary.

## Run it

```bash
pnpm --filter @imajin/kernel dev   # http://localhost:3000
```

Full setup guide: [docs/DEVELOPER.md](../../docs/DEVELOPER.md).
