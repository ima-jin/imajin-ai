# @imajin/kernel

The kernel — the Next.js application implementing the six primitives (Attestation, Communication, Attribution, Settlement, Discovery, Revocation) and the rails that serve them (auth, pay, registry, connections, chat, media, bus). This is not a third-party app; it's what a node operator runs.

Dykil and events currently run inside this same monorepo as separate services pending extraction behind the registered-app contract ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)) — see the [root README](../../README.md) for the kernel/app boundary. `links` was the first app to leave: `apps/links` was pruned on 2026-09-28 and it now lives at [ima-jin/links](https://github.com/ima-jin/links). `learn` was pruned in [#2503](https://github.com/ima-jin/imajin-ai/issues/2503) and now lives at [ima-jin/learn](https://github.com/ima-jin/learn). `coffee` was pruned in [#2500](https://github.com/ima-jin/imajin-ai/issues/2500) and now lives at [ima-jin/coffee](https://github.com/ima-jin/coffee). `market` was pruned in [#2512](https://github.com/ima-jin/imajin-ai/issues/2512) and now lives at [ima-jin/market](https://github.com/ima-jin/market).

## Run it

```bash
pnpm --filter @imajin/kernel dev   # http://localhost:3000
```

Full setup guide: [docs/DEVELOPER.md](../../docs/DEVELOPER.md).

## Inference connectors

Brain connectors (`BRAIN_CONNECTORS` in `src/lib/inference/brain.ts`, `CONNECTOR_REGISTRY` in `src/lib/kernel/connector-registry.ts`) let a DID seal its own provider API key for the completions passthrough (`POST /infer/v1/chat/completions`) instead of a shared env var — see the [inference connectors epic](https://github.com/ima-jin/imajin-ai/issues/1922). In resolution order:

| Connector | Provider adapter | Notes |
|---|---|---|
| Gemini | `openai` (compatible) | No hardcoded default model (#1769) |
| Anthropic | `anthropic` | Main-session brain; migrates last (#1922) |
| xAI | `openai` (compatible) | |
| OpenAI | `openai` | |
| Moonshot AI (Kimi) | `openai` (compatible) | |
| Z.ai (GLM) | `openai` (compatible) | |
| Local Inference | `openai` (compatible) | Owner-supplied `baseUrl`; no sealed key required (#1957) |
| OpenRouter | `openai` (compatible) | Router, not a single provider — one sealed key reaches every model it fronts; `provider/model` ids (e.g. `typesafe/jev-1.13`) forward untouched (#2188) |
