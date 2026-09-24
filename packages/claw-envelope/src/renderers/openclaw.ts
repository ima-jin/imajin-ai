/**
 * OpenClaw renderer (imajin-ai#2186, RFC-31 Phase 1).
 *
 * Maps a harness-agnostic `ContextEnvelope` onto OpenClaw's own workspace and
 * plugin-config shape. Verified against a local checkout of the
 * `openclaw-imajin-plugin` package (the Imajin channel/tool plugin for
 * OpenClaw — `openclaw.plugin.json`, `index.ts`, `README.md`, 2026-09
 * snapshot), NOT assumed:
 *
 *   - `openclaw.plugin.json`'s `configSchema` requires `nodeUrl` and accepts
 *     `did` + `keypairPath` for Ed25519 challenge-response auth — the plugin's
 *     own `client.ts`/`ws-service.ts` sign a kernel-issued challenge with the
 *     keypair at `keypairPath`; NO static API key/PAT is ever configured or
 *     sent (this repo's NOT-PAT anti-goal, same auth model
 *     `packages/nanoclaw-imajin-channel` already uses for NanoClaw).
 *   - `index.ts`'s own module doc gives the canonical minimal example this
 *     renderer mirrors exactly: `{ "nodeUrl": "https://jin.imajin.ai", "did":
 *     "did:imajin:...", "keypairPath": "/path/to/.jin-identity.json" }` —
 *     literal, operator-edited values, not env-var templates. Unlike
 *     `hookToken`/`notifyWebhookSecret`/`internalApiKey` (which the plugin's
 *     own `configSchema` documents as SecretRef-or-env-var-fallback fields),
 *     `nodeUrl`/`did`/`keypairPath` have no documented env-var fallback in
 *     that schema, so this renderer does not invent one.
 *
 * Unlike NanoClaw, OpenClaw's real on-disk workspace shape genuinely IS
 * RFC-31's own vocabulary (`docs/rfcs/RFC-31-agent-execution-sandbox.md`'s
 * "Workspace: The Agent IS Its Files" section: `AGENTS.md`, `SOUL.md`,
 * `MEMORY.md`, `USER.md`, `memory/README.md`, `memory/context/*.md`) — so
 * this renderer does not need NanoClaw's persona-squash step
 * (`instructions.prepend.md`) or a channel-adapter copy/barrel-import step:
 * the Imajin tool/channel surface for OpenClaw ships as a normal OpenClaw
 * plugin (`openclaw-imajin-plugin`, a sibling repo), wired entirely through
 * `openclaw.json` config — no source-tree fork, no copy step.
 *
 * `USER.md` is NOT a `ContextEnvelope.workspace` field — imajin-ai#1758's
 * `WorkspaceFiles` type only carries the three files NanoClaw's real persona
 * surface consumes (`SOUL.md`/`AGENTS.md`/`MEMORY.md`). Per imajin-ai#2186's
 * "no new envelope schema unless truly unavoidable" constraint, `USER.md` is
 * derived here entirely from EXISTING `ContextEnvelope` fields already
 * consumed elsewhere (`ownerDid` — the same field NanoClaw's env template
 * already renders; `delegationGrants`; `busRoutes`) rather than adding a
 * field to `WorkspaceFiles`: avoidable, so avoided. No envelope schema change
 * ships in this renderer.
 */
import type { ContextEnvelope, RenderedFile, RenderedTree } from '../types';

const HARNESS = 'openclaw';

/** Matches this plugin's own README default (`nodeUrl: "https://jin.imajin.ai"`). */
const DEFAULT_KERNEL_BASE_URL = 'https://jin.imajin.ai';

export interface RenderOpenClawOptions {
  /**
   * Real kernel base URL for the imajin plugin's `openclaw.json` `nodeUrl`
   * (not a secret — safe to bake in literally, same treatment NanoClaw's
   * `.env.example` already gives `NANOCLAW_AGENT_DID`). Defaults to this
   * plugin's own documented example, `https://jin.imajin.ai`.
   */
  kernelBaseUrl?: string;
  /**
   * Optional operator-supplied extra context files (RFC-31's
   * `memory/context/*.md` position). Keys are bare file names (e.g.
   * `'project-notes.md'`) written under `openclaw/memory/context/`; values
   * are the file content verbatim. Never derived from the envelope itself —
   * purely an operator-provided bundle, the same way the CLI's `--purpose`
   * flag is operator-provided prose. Omit for the position-stub-only
   * default (an empty `memory/context/` with just a README explaining what
   * goes there).
   */
  contextBundle?: Readonly<Record<string, string>>;
}

function userMd(envelope: ContextEnvelope): string {
  const grantList =
    envelope.delegationGrants.map((g) => `- \`${g.capability}\`${g.note ? ` — ${g.note}` : ''}`).join('\n') ||
    '- (none requested)';
  const busRouteList =
    envelope.busRoutes.map((r) => `- \`${r.eventType}\` — ${r.description}`).join('\n') || '- (none)';
  return `# USER.md — ${envelope.handle}

This agent serves \`${envelope.ownerDid}\` as its principal. Every delegated
action this agent takes is scoped by the grants below — nothing implicit,
nothing beyond what the principal has actually delegated (imajin-ai#1922
use-not-see).

## Principal
- Owner DID: \`${envelope.ownerDid}\`
- Agent DID: \`${envelope.agentDid}\`

## What this agent may do on the principal's behalf
${grantList}

## How the principal reaches this agent
${busRouteList}
`;
}

function memoryReadmeMd(envelope: ContextEnvelope): string {
  return `# memory/ — ${envelope.handle}

Daily logs and context files this agent accumulates once it starts
operating. Nothing under this directory is seeded with real content by the
provisioner beyond the \`context/\` position stub below — this workspace's
curated long-term continuity is \`../MEMORY.md\`, the provisioner's own
rendered output.

- \`YYYY-MM-DD.md\` — daily logs, written by the running agent, not this provisioner.
- \`context/\` — supplementary context files; see \`context/README.md\`.
`;
}

function memoryContextReadmeMd(envelope: ContextEnvelope, hasBundleFiles: boolean): string {
  if (hasBundleFiles) {
    return `# memory/context/ — ${envelope.handle}

Supplementary context files supplied by the operator at provisioning time,
alongside this position stub. Additional files the agent itself writes
during operation land here too — nothing here is templated or placeholder
content once populated.
`;
  }
  return `# memory/context/ — position stub

Empty at first boot. This is where supplementary context files (operator-
supplied background, project notes, etc.) live once added — either by the
operator before first boot, or by the agent itself during operation.
imajin-ai#2186 renders this directory's position only; content is added
deliberately, never templated.
`;
}

/**
 * `openclaw.json`'s `plugins.entries.imajin.config` (confirmed against
 * `openclaw-imajin-plugin`'s `openclaw.plugin.json` `configSchema` +
 * `index.ts`'s own module-doc example). `nodeUrl` and `did` are real,
 * non-secret values (same treatment NanoClaw's `.env.example` already gives
 * `NANOCLAW_AGENT_DID`). `keypairPath` is a literal, operator-edited
 * placeholder path — matching `index.ts`'s own doc-comment example
 * (`"/path/to/.jin-identity.json"`) exactly, since this field has no
 * documented env-var/SecretRef fallback in the plugin's `configSchema`
 * (unlike `hookToken`/`internalApiKey`, which do). Never a real path guess,
 * never a secret value — the operator must place the real keypair file at
 * whatever path they put here before first boot.
 */
function openclawJson(envelope: ContextEnvelope, kernelBaseUrl: string): string {
  const config = {
    plugins: {
      entries: {
        imajin: {
          enabled: true,
          config: {
            nodeUrl: kernelBaseUrl,
            did: envelope.agentDid,
            keypairPath: `/path/to/.agent-${envelope.handle}.json`,
          },
        },
      },
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

function setupMd(envelope: ContextEnvelope): string {
  return `# SETUP — Imajin plugin into an OpenClaw install

Generated for agent DID \`${envelope.agentDid}\` (handle \`${envelope.handle}\`).
Unlike NanoClaw, this is config-only — OpenClaw consumes \`AGENTS.md\`/\`SOUL.md\`/
\`MEMORY.md\`/\`USER.md\` and \`memory/\` natively, and the Imajin tool/channel
surface ships as a normal OpenClaw plugin, not a source-tree fork.

## 1. Install OpenClaw and the Imajin plugin

Install OpenClaw itself (see OpenClaw's own docs — not something this
renderer can script blind) and place the \`openclaw-imajin-plugin\` package
(a sibling repo, not published to npm — \`private: true\` in its own
\`package.json\`) where OpenClaw's own plugin loader discovers it. That
package declares \`"openclaw": {"extensions": ["./index.ts"]}\` in its
\`package.json\` — consult OpenClaw's own extension/plugin-loading docs for
exactly how that's resolved (workspace-local path vs. an installed
dependency) on the OpenClaw version you're running; this renderer only
emits the config half.

## 2. Place the rendered workspace files

\`\`\`
openclaw/AGENTS.md
openclaw/SOUL.md
openclaw/MEMORY.md
openclaw/USER.md
openclaw/memory/README.md
openclaw/memory/context/README.md
\`\`\`

into the OpenClaw workspace directory for this agent (per OpenClaw's own
workspace-location convention).

## 3. Place and fill in the plugin config

Copy \`openclaw/openclaw.json\`'s \`plugins.entries.imajin\` block into this
agent's own \`openclaw.json\` (merge, don't overwrite, if that file already
has other plugins configured), then replace its \`keypairPath\` placeholder
(\`/path/to/.agent-${envelope.handle}.json\`) with the REAL path to the
0600 keypair file minted for \`${envelope.agentDid}\` on this host — never
commit that file, and never rename it into a path this renderer already
guessed correctly by coincidence.

## 4. Model provider (left to the operator)

This renderer does not configure a model provider — OpenClaw's own
\`agents.defaults\`/model-provider config is the operator's choice, entirely
separate from the Imajin plugin's \`nodeUrl\`/\`did\`/\`keypairPath\`. See
\`openclaw-imajin-plugin\`'s README "Kernel brains as OpenClaw models" section
if you want to route OpenClaw's own model calls through the kernel's
inference passthrough — that is an independent, optional step.

## 5. Start and validate

\`\`\`bash
openclaw config validate
openclaw gateway restart
\`\`\`

(or your OpenClaw install's equivalent start command). See
\`docs/agents/openclaw-first-boot.md\` for the full checklist and what could
and could not be verified in this sandbox.
`;
}

/** Render a `ContextEnvelope` onto OpenClaw's real workspace + plugin-config shape. */
export function renderOpenClaw(envelope: ContextEnvelope, opts: RenderOpenClawOptions = {}): RenderedTree {
  const kernelBaseUrl = opts.kernelBaseUrl ?? DEFAULT_KERNEL_BASE_URL;
  const contextBundle = opts.contextBundle ?? {};
  const hasBundleFiles = Object.keys(contextBundle).length > 0;

  const files: RenderedFile[] = [
    { relativePath: 'envelope/SOUL.md', content: envelope.workspace['SOUL.md'] },
    { relativePath: 'envelope/AGENTS.md', content: envelope.workspace['AGENTS.md'] },
    { relativePath: 'envelope/MEMORY.md', content: envelope.workspace['MEMORY.md'] },
    { relativePath: 'openclaw/AGENTS.md', content: envelope.workspace['AGENTS.md'] },
    { relativePath: 'openclaw/SOUL.md', content: envelope.workspace['SOUL.md'] },
    { relativePath: 'openclaw/MEMORY.md', content: envelope.workspace['MEMORY.md'] },
    { relativePath: 'openclaw/USER.md', content: userMd(envelope) },
    { relativePath: 'openclaw/memory/README.md', content: memoryReadmeMd(envelope) },
    { relativePath: 'openclaw/memory/context/README.md', content: memoryContextReadmeMd(envelope, hasBundleFiles) },
    { relativePath: 'openclaw/openclaw.json', content: openclawJson(envelope, kernelBaseUrl) },
    { relativePath: 'openclaw/SETUP.md', content: setupMd(envelope) },
  ];

  for (const [name, content] of Object.entries(contextBundle)) {
    files.push({ relativePath: `openclaw/memory/context/${name}`, content });
  }

  const manualSteps = [
    'Install OpenClaw and place the openclaw-imajin-plugin package where its plugin loader discovers it (openclaw/SETUP.md step 1) — a sibling, unpublished (private) package, not something this renderer can install blind.',
    `Replace openclaw.json's keypairPath placeholder with the REAL path to the 0600 keypair file minted for ${envelope.agentDid} on the deploy host before first boot — never the placeholder path, never the key material itself anywhere else.`,
    "Model provider is left to the operator — this renderer does not configure OpenClaw's own model/provider settings (openclaw/SETUP.md step 4).",
    envelope.config.model.via === 'direct'
      ? `Brain deviation: ${envelope.config.model.deviation ?? "brain.via: 'direct'"} — set the corresponding provider key on OpenClaw's own model config, not this plugin.`
      : "OpenClaw's own model provider is independent of this envelope's brain.via/model fields (unlike NanoClaw's ANTHROPIC_BASE_URL passthrough) — see openclaw/SETUP.md step 4.",
  ];

  return { harness: HARNESS, files, manualSteps };
}
