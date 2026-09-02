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
    // Model left unset when placement is 'hosted' with a deviation: the
    // underlying Claude Code CLI picks up ANTHROPIC_API_KEY / (optionally)
    // ANTHROPIC_BASE_URL from the container env (`env: { ...process.env }`
    // in `container/agent-runner/src/index.ts`) — see AGENTS.md / the design
    // doc for the brain-path decision and its documented deviation.
  };
  return JSON.stringify(config, null, 2) + '\n';
}

function envExample(envelope: ContextEnvelope): string {
  const lines = [
    '# Variable NAMES only — set real values on the deploy host, never commit them.',
    '',
    'KERNEL_BASE_URL=',
    `NANOCLAW_AGENT_DID=${envelope.agentDid}`,
    `NANOCLAW_OWNER_DID=${envelope.ownerDid}`,
    'NANOCLAW_AGENT_KEYPAIR_PATH=',
    'MCP_PROXY_PORT=8788',
  ];
  if (envelope.config.model.deviation) {
    lines.push('', `# Deviation: ${envelope.config.model.deviation}`, 'DIRECT_BRAIN_API_KEY=');
  }
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
README and \`deploy/nanoclaw/docker-compose.yml\`) alongside the NanoClaw container.

## 5. Build and validate

\`\`\`
pnpm run build
\`\`\`

See \`docs/agents/nanoclaw-first-boot.md\` for the full harvested checklist.
`;
}

/** Render a `ContextEnvelope` onto NanoClaw's real layout. */
export function renderNanoClaw(envelope: ContextEnvelope, opts: { mcpProxyPort?: number } = {}): RenderedTree {
  const mcpProxyPort = opts.mcpProxyPort ?? 8788;
  const folder = groupFolderFor(envelope.handle);

  const files: RenderedFile[] = [
    { relativePath: 'envelope/SOUL.md', content: envelope.workspace['SOUL.md'] },
    { relativePath: 'envelope/AGENTS.md', content: envelope.workspace['AGENTS.md'] },
    { relativePath: 'envelope/MEMORY.md', content: envelope.workspace['MEMORY.md'] },
    { relativePath: `nanoclaw/groups/${folder}/instructions.prepend.md`, content: instructionsPrependMd(envelope) + '\n' },
    { relativePath: `nanoclaw/groups/${folder}/memory/README.md`, content: memoryReadmeMd(envelope) },
    { relativePath: `nanoclaw/groups/${folder}/container.json`, content: containerJson(envelope, mcpProxyPort) },
    { relativePath: 'nanoclaw/.env.example', content: envExample(envelope) },
    { relativePath: 'nanoclaw/APPLY.md', content: applyMd(envelope, folder) },
  ];

  const manualSteps = [
    'Copy the imajin-chat channel adapter into the NanoClaw checkout and append the barrel import (nanoclaw/APPLY.md, steps 1-2) — scriptable in the deploy Dockerfile build stage, not yet scripted here.',
    'Mint the app.authorized attestation granting the mcp-proxy app DID MCP scope (owner consent step — cannot be automated away).',
    envelope.config.model.deviation
      ? `Brain deviation: ${envelope.config.model.deviation} — set DIRECT_BRAIN_API_KEY on the deploy host.`
      : 'Confirm the kernel completions passthrough route for the chosen brain provider.',
  ];

  return { harness: HARNESS, files, manualSteps };
}
