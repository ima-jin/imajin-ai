# @imajin/kernel

The kernel — the Next.js application implementing the six primitives (Attestation, Communication, Attribution, Settlement, Discovery, Revocation) and the rails that serve them (auth, pay, registry, connections, chat, media, bus). This is not a third-party app; it's what a node operator runs.

Coffee, dykil, links, learn, events, and market currently run inside this same monorepo as separate services pending extraction behind the registered-app contract ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)) — see the [root README](../../README.md) for the kernel/app boundary.

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
