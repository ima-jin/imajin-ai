/**
 * NanoClaw renderer (imajin-ai#1932/#1933).
 *
 * Maps a harness-agnostic `ContextEnvelope` onto NanoClaw's ACTUAL discovered
 * layout (verified against a clone of qwibitai/nanoclaw, 2026-09-02 push —
 * see docs/agents/nanoclaw-first-boot.md for the full research trail):
 *
 *   - Persona: NOT separate SOUL.md/AGENTS.md/MEMORY.md files inside a
 *     NanoClaw checkout. NanoClaw's real surface is ONE file,
 *     `groups/<folder>/instructions.prepend.md` (`PERSONA_PREPEND_FILE` in
 *     `src/group-persona.ts`), prepended verbatim into the composed
 *     `CLAUDE.md` every spawn. `MEMORY.md`'s content seeds
 *     `groups/<folder>/memory/README.md` (the "Memory: memory/." convention
 *     `project-doc-compose.ts`'s COMPOSED_HEADER documents).
 *   - Config: `groups/<folder>/container.json` (`RunnerConfig` in
 *     `container/agent-runner/src/config.ts`) carries `provider`,
 *     `assistantName`, and `mcpServers` (a `{ type: 'http', url, headers? }`
 *     or `{ type: 'stdio', command, args, env }` map).
 *   - Channel: NanoClaw ships NO channel adapters in trunk — they are
 *     copied into `src/channels/` and self-registered via one import line
 *     appended to `src/channels/index.ts`, exactly like every real
 *     `/add-<channel>` skill does. This renderer does NOT duplicate the
 *     channel adapter's source (that lives in
 *     `packages/nanoclaw-imajin-channel`, the single source of truth) — it
 *     emits an `APPLY.md` with the same directive shape those skills use, so
 *     applying it is a copy + one-line import + rebuild, never a NanoClaw
 *     source-tree fork.
 *   - Env: only variable NAMES are ever rendered — no secret values.
 */
import type { ContextEnvelope, RenderedFile, RenderedTree } from '../types.js';

const HARNESS = 'nanoclaw';

/** Directory-safe slug for the agent group folder NanoClaw expects under `groups/`. */
export function groupFolderFor(handle: string): string {
  const slug = handle
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .split('-')
    .filter(Boolean)
    .join('-');
  return slug || 'imajin-agent';
}

function instructionsPrependMd(envelope: ContextEnvelope): string {
  return [envelope.workspace['SOUL.md'].trim(), envelope.workspace['AGENTS.md'].trim()].join('\n\n');
}

function memoryReadmeMd(envelope: ContextEnvelope): string {
  return envelope.workspace['MEMORY.md'];
}

/**
 * `container.json` (`RunnerConfig`, `container/agent-runner/src/config.ts`).
 * The MCP entry points at the loopback mcp-proxy sidecar
 * (`packages/nanoclaw-imajin-channel/src/mcp-proxy`) — NOT directly at
 * `mcp.imajin.ai` — because NanoClaw's `http` MCP shape carries only STATIC
 * headers, and `mcp.imajin.ai` access requires a short-lived (10-minute),
 * caller-refreshed app-token JWT (imajin-ai#1922 finding 6). The proxy is the
 * "smallest possible sidecar" for that missing extension point.
 *
 * The model/brain itself is NOT part of `container.json` — the underlying
 * Claude Code CLI picks up `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` from the
 * container env (`env: { ...process.env }` in
 * `container/agent-runner/src/index.ts`); see `envExample()` below for how
 * those two vars are set for each `brain.via` choice.
 */
function containerJson(envelope: ContextEnvelope, mcpProxyPort: number): string {
  const config = {
    provider: 'claude',
    assistantName: envelope.handle,
    mcpServers: {
      imajin: {
        type: 'http',
        url: `http://127.0.0.1:${mcpProxyPort}/mcp`,
      },
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Brain env for the two `brain.via` choices (imajin-ai#1959/#1961):
 *   'kernel-passthrough' (default) — point at the openclaw-infer-passthrough
 *     shim's fixed `/anthropic` prefix; `ANTHROPIC_API_KEY` is a placeholder
 *     the shim never checks (real auth is kernel-side, via a minted
 *     app-token sent as `x-api-key`). No provider key on this container.
 *   'direct' — explicit break-glass: bypass the shim, talk to the provider
 *     directly with a real, scoped key (`DIRECT_BRAIN_API_KEY`).
 */
function brainEnvLines(envelope: ContextEnvelope, inferProxyHost: string, inferProxyPort: number): string[] {
  if (envelope.config.model.via === 'direct') {
    const deviation = envelope.config.model.deviation ?? "brain.via: 'direct' break-glass";
    return [
      '',
      `# Deviation: ${deviation}`,
      '# DIRECT_BRAIN_API_KEY is this container\'s real ANTHROPIC_API_KEY value —',
      '# named distinctly here so it is never confused with the kernel-passthrough',
      "# path's non-secret 'unused-placeholder'.",
      'DIRECT_BRAIN_API_KEY=',
    ];
  }
  return [
    '',
    '# Brain: reached via the kernel Anthropic-format completions passthrough',
    '# (imajin-ai#1959/#1961) through the openclaw-infer-passthrough shim.',
    '# No provider key on this container — see deploy/nanoclaw/docker-compose.yml.',
    `ANTHROPIC_BASE_URL=http://${inferProxyHost}:${inferProxyPort}/anthropic`,
    'ANTHROPIC_API_KEY=unused-placeholder',
  ];
}

function envExample(envelope: ContextEnvelope, inferProxyHost: string, inferProxyPort: number): string {
  const lines = [
    '# Variable NAMES only — set real values on the deploy host, never commit them.',
    '',
    'KERNEL_BASE_URL=',
    `NANOCLAW_AGENT_DID=${envelope.agentDid}`,
    `NANOCLAW_OWNER_DID=${envelope.ownerDid}`,
    'NANOCLAW_AGENT_KEYPAIR_PATH=',
    'MCP_PROXY_PORT=8788',
    ...brainEnvLines(envelope, inferProxyHost, inferProxyPort),
  ];
  for (const secret of envelope.secrets) {
    if (secret.kind === 'env-var' && !lines.some((l) => l.startsWith(`${secret.name}=`))) {
      lines.push(secret.purpose ? `# ${secret.purpose}` : '', `${secret.name}=`);
    }
  }
  return lines.join('\n') + '\n';
}

function applyMd(envelope: ContextEnvelope, folder: string): string {
  return `# APPLY — imajin-chat channel into a NanoClaw checkout

Generated for agent DID \`${envelope.agentDid}\` (handle \`${envelope.handle}\`). Follow this
exactly once per NanoClaw checkout, the same way any real \`/add-<channel>\` skill applies
(imajin-ai#1932 — no NanoClaw fork, this is NanoClaw's own documented extension seam).

## 1. Copy the channel adapter

Copy \`packages/nanoclaw-imajin-channel/src/channel-adapter.ts\` (and its \`src/auth/\`,
\`src/imajin-client.ts\` dependencies) into the NanoClaw checkout's \`src/channels/imajin-chat.ts\`
(and siblings).

## 2. Register the adapter

Append to \`src/channels/index.ts\`:

\`\`\`
import './imajin-chat.js';
\`\`\`

## 3. Place the rendered group files

\`\`\`
groups/${folder}/instructions.prepend.md
groups/${folder}/memory/README.md
groups/${folder}/container.json
\`\`\`

## 4. Start the sidecars

Run \`packages/nanoclaw-imajin-channel\`'s \`mcp-proxy\` and \`usage-emitter\` (see that package's
README and \`deploy/nanoclaw/docker-compose.yml\`) alongside the NanoClaw container. When the
brain is reached via the kernel passthrough (the default — see \`.env.example\`), also run
the \`infer-passthrough\` shim (\`packages/openclaw-infer-passthrough\`, its own existing
container/entry — not a new proxy) so \`ANTHROPIC_BASE_URL\` has something to point at.

## 5. Build and validate

\`\`\`
pnpm run build
\`\`\`

See \`docs/agents/nanoclaw-first-boot.md\` for the full harvested checklist.
`;
}

export interface RenderNanoClawOptions {
  mcpProxyPort?: number;
  /** Compose service name (or host) the openclaw-infer-passthrough shim is reachable at. Default matches deploy/nanoclaw/docker-compose.yml's service name. */
  inferProxyHost?: string;
  inferProxyPort?: number;
}

/** Render a `ContextEnvelope` onto NanoClaw's real layout. */
export function renderNanoClaw(envelope: ContextEnvelope, opts: RenderNanoClawOptions = {}): RenderedTree {
  const mcpProxyPort = opts.mcpProxyPort ?? 8788;
  const inferProxyHost = opts.inferProxyHost ?? 'infer-passthrough';
  const inferProxyPort = opts.inferProxyPort ?? 8787;
  const folder = groupFolderFor(envelope.handle);

  const files: RenderedFile[] = [
    { relativePath: 'envelope/SOUL.md', content: envelope.workspace['SOUL.md'] },
    { relativePath: 'envelope/AGENTS.md', content: envelope.workspace['AGENTS.md'] },
    { relativePath: 'envelope/MEMORY.md', content: envelope.workspace['MEMORY.md'] },
    { relativePath: `nanoclaw/groups/${folder}/instructions.prepend.md`, content: instructionsPrependMd(envelope) + '\n' },
    { relativePath: `nanoclaw/groups/${folder}/memory/README.md`, content: memoryReadmeMd(envelope) },
    { relativePath: `nanoclaw/groups/${folder}/container.json`, content: containerJson(envelope, mcpProxyPort) },
    { relativePath: 'nanoclaw/.env.example', content: envExample(envelope, inferProxyHost, inferProxyPort) },
    { relativePath: 'nanoclaw/APPLY.md', content: applyMd(envelope, folder) },
  ];

  const manualSteps = [
    'Copy the imajin-chat channel adapter into the NanoClaw checkout and append the barrel import (nanoclaw/APPLY.md, steps 1-2) — scriptable in the deploy Dockerfile build stage, not yet scripted here.',
    'Mint the app.authorized attestation granting the mcp-proxy app DID the mcp scope (owner consent step — cannot be automated away).',
    envelope.config.model.via === 'direct'
      ? `Brain deviation: ${envelope.config.model.deviation ?? "brain.via: 'direct'"} — set DIRECT_BRAIN_API_KEY on the deploy host.`
      : "Mint the app.authorized attestation granting this agent's app DID infer:completions scope, and set its attestationId/principalDid on the infer-passthrough shim's \"anthropic\" route entry (owner consent step — cannot be automated away).",
  ];

  return { harness: HARNESS, files, manualSteps };
}
