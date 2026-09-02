/**
 * RFC-31 v2 context-envelope types (imajin-ai#1758, #1932, #1933).
 *
 * The envelope is harness-agnostic by design: everything in this module is
 * plain data with no NanoClaw (or OpenClaw, or any other harness) shape
 * baked in. A renderer (see `renderers/`) maps a `ContextEnvelope` onto one
 * harness's actual on-disk/config/env layout.
 *
 * Load-bearing constraint (imajin-ai#1922 anti-goal, inherited here): a
 * `DelegationGrantRef` may only ever carry a vault FIELD NAME or a grant ID
 * — never a secret value. `SecretRef` is typed to make a raw-value field
 * impossible to add by accident (no optional `value`/`secret`/`key` member
 * exists on the type at all).
 */

/** A brain choice is a build decision (imajin-ai#1932), not a premise. */
export type BrainPlacement = 'local' | 'hosted';

export interface BrainChoice {
  placement: BrainPlacement;
  /**
   * Human-readable label for the chosen model/provider (e.g. `'anthropic:claude'`,
   * `'ollama:qwen3'`). Not interpreted by the generator — renderers decide how
   * to wire it into harness-specific config.
   */
  provider: string;
  /**
   * True when this brain choice is a documented deviation from the kernel's
   * sealed-connector path (imajin-ai#1922) — e.g. a scoped direct provider key
   * supplied via container env because no kernel passthrough exists yet for
   * this harness's wire format. Renderers surface this prominently so it is
   * never silently normalized away.
   */
  deviation?: string;
}

/**
 * A reference to a secret's LOCATION, never its value. `field` names the
 * vault entry (see `packages/vault-core`) or an environment variable NAME
 * the renderer should declare in a `.env.example`-style template.
 */
export interface SecretRef {
  kind: 'vault-field' | 'env-var';
  name: string;
  /** Free-text note on what the secret is for — rendered as a comment. */
  purpose?: string;
}

/** A reference to an existing (or intended) delegation grant — never the grant's authority itself. */
export interface DelegationGrantRef {
  /** Grant capability string from the closed registry (`@imajin/auth`'s `GRANT_SCOPE_REGISTRY`). */
  capability: string;
  /** Grant id, once issued (`POST /auth/api/grants` response). Absent before bootstrap runs. */
  grantId?: string;
  note?: string;
}

/** One `bus_chain_configs`-shaped route declaration (imajin-ai#1758). */
export interface BusRoute {
  /** Event type this route reacts to, e.g. `chat.message.received`. */
  eventType: string;
  /** Free-text description of what the route does — renderers turn this into config/docs. */
  description: string;
}

/** The intent a caller declares when asking for an envelope (imajin-ai#1933's provisioner input shape). */
export interface EnvelopeIntent {
  /** Grant capability strings requested for this instance (subset of `GRANT_SCOPE_REGISTRY`). */
  scopes: readonly string[];
  busRoutes: readonly BusRoute[];
  brain: BrainChoice;
  /** Short prose describing the instance's purpose — seeds SOUL.md/AGENTS.md. */
  purpose: string;
}

export interface ContextEnvelopeInput {
  agentDid: string;
  ownerDid: string;
  /** Display handle for the instance (e.g. `'nanoclaw-poc'`) — used in generated docs, not identity. */
  handle: string;
  intent: EnvelopeIntent;
}

/** Harness-agnostic workspace file skeleton — filenames are RFC-31's own vocabulary. */
export interface WorkspaceFiles {
  'SOUL.md': string;
  'AGENTS.md': string;
  'MEMORY.md': string;
}

/** Harness-agnostic runtime config hints (imajin-ai#1758's `config.json` line of the envelope). */
export interface EnvelopeConfig {
  model: {
    placement: BrainPlacement;
    provider: string;
    deviation?: string;
  };
  execPolicy: {
    /** Minimal-by-default (imajin-ai#1932 scope item 3): read + one write surface. */
    allowWrite: boolean;
  };
  mcp: {
    /** MCP server base URL the harness should reach tools through. */
    serverUrl: string;
    /** Grant capabilities gating tool access — informational; enforcement is kernel-side. */
    scopes: readonly string[];
  };
}

/** The rendered, harness-agnostic envelope (imajin-ai#1758's five-part list). */
export interface ContextEnvelope {
  agentDid: string;
  ownerDid: string;
  handle: string;
  workspace: WorkspaceFiles;
  config: EnvelopeConfig;
  delegationGrants: readonly DelegationGrantRef[];
  secrets: readonly SecretRef[];
  busRoutes: readonly BusRoute[];
}

/** One file to write, relative to a renderer's output root. Content is always plain text. */
export interface RenderedFile {
  relativePath: string;
  content: string;
}

/** A renderer's full output: files to write plus a short human summary of what was rendered. */
export interface RenderedTree {
  harness: string;
  files: readonly RenderedFile[];
  /** Steps a human/operator must still take that this renderer cannot itself perform. */
  manualSteps: readonly string[];
}
