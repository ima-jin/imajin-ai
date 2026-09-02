/**
 * Declarative scope vocabulary — the single source of truth (#1253).
 *
 * Before this module, adding one connector scope meant editing five hand-synced
 * lists: `SCOPES`, `MCP_SCOPES`, the connector's `*_SCOPE_DESCRIPTORS`, the
 * `CONNECTOR_REGISTRY` UI list, and the connector's `*ScopeReleaseClass()`
 * copy. Miss one and it still typechecks, still ships, and fails silently in
 * prod — which is exactly what happened to `messages:*` in #1393: the scope
 * existed server-side but never rendered a toggle, so nobody could grant it.
 *
 * Everything is now a projection of the table below:
 *   SCOPES / validateScopes()          → ./scopes.ts
 *   MCP_SCOPES (OAuth ceiling)         → apps/kernel/src/lib/mcp/oauth-config.ts
 *   *_SCOPE_DESCRIPTORS, VALID_*_SCOPES→ apps/kernel/src/lib/kernel/scope-projections.ts
 *   CONNECTOR_REGISTRY[].scopes (UI)   → apps/kernel/src/lib/kernel/connector-registry.ts
 *
 * Adding a scope is ONE edit: append an entry here.
 *
 * IMPORTANT: this module must stay dependency-free and client-safe (no imports
 * at all, no `node:` builtins, no DB). It is imported by client components via
 * the `@imajin/auth/scope-vocabulary` subpath so they never pull the
 * server-heavy `@imajin/auth` index into a browser bundle.
 *
 * Refs: #1253 (this) · #1196 (consent 2×2) · #1184 (grantable ≠ granted) ·
 *       #1393 (the prod miss this prevents) · #517 (same idea, attestation types)
 */

// ── Identity ──────────────────────────────────────────────────────────────────

/** Connectors that can own scopes. */
export type ConnectorId = 'mcp' | 'github' | 'discord' | 'gemini' | 'anthropic' | 'xai' | 'openai' | 'moonshot' | 'zai' | 'gcp' | 'quickbooks' | 'warp' | 'stripe';

/**
 * Capability surfaces that can *carry* a scope in an access token.
 *
 * Distinct from ownership: `github:read` is owned by the GitHub connector but
 * is legitimately carried by MCP tokens, so it is `connector: 'github'` with
 * `surfaces: ['mcp']`.
 */
export type CapabilitySurface = 'mcp';

/** Connector app DIDs — the only place these strings are declared. */
export const CONNECTOR_DIDS: Readonly<Record<ConnectorId, string>> = {
  mcp: 'did:imajin:mcp-connector',
  github: 'did:imajin:github-connector',
  discord: 'did:imajin:discord-connector',
  gemini: 'did:imajin:gemini-connector',
  anthropic: 'did:imajin:anthropic-connector',
  xai: 'did:imajin:xai-connector',
  openai: 'did:imajin:openai-connector',
  moonshot: 'did:imajin:moonshot-connector',
  zai: 'did:imajin:zai-connector',
  gcp: 'did:imajin:gcp-connector',
  quickbooks: 'did:imajin:quickbooks-connector',
  warp: 'did:imajin:warp-connector',
  stripe: 'did:imajin:stripe-connector',
};

/** Channel label used in `auth.channel_links`. Currently always the id. */
export const CONNECTOR_CHANNELS: Readonly<Record<ConnectorId, string>> = {
  mcp: 'mcp',
  github: 'github',
  discord: 'discord',
  gemini: 'gemini',
  anthropic: 'anthropic',
  xai: 'xai',
  openai: 'openai',
  moonshot: 'moonshot',
  zai: 'zai',
  gcp: 'gcp',
  quickbooks: 'quickbooks',
  warp: 'warp',
  stripe: 'stripe',
};

// ── Release tiers (#1196 consent 2×2) ─────────────────────────────────────────

/**
 * Release tier, mirroring `FairReleaseTier` in `@imajin/fair`.
 *
 *   silent     — freely projectable; materialises on manifest publish
 *   on-consent — materialises only when a consent_grants row exists
 *   owner-only — never released to a third party; the owner must grant it
 *   never      — structural drop; can never materialise
 */
export type ScopeReleaseTier = 'silent' | 'on-consent' | 'owner-only' | 'never';

/**
 * Tiers usable as an explicit override. `silent` is excluded on purpose: an
 * override may only ever *tighten* what the 2×2 derives, never loosen it.
 */
export type ScopeReleaseOverride = Exclude<ScopeReleaseTier, 'silent'>;

/** The two axes of the #1196 2×2. */
export interface ScopeClassification {
  /** True when exercising the scope exposes data about people other than the owner. */
  disclosesOthers: boolean;
  /** True when the scope touches credential-grade or otherwise sensitive material. */
  sensitive: boolean;
}

// ── Entry shapes ──────────────────────────────────────────────────────────────

interface BaseScopeEntry {
  /** The scope string, e.g. `media:read`. Unique across the vocabulary. */
  scope: string;
  /**
   * Consent-screen label — what `SCOPES` maps to, shown at /auth/authorize
   * and /auth/apps. Written from the *user's* point of view.
   */
  label: string;
  /** Capability surfaces whose tokens may carry this scope. */
  surfaces?: readonly CapabilitySurface[];
  /**
   * True when a session-less service token (`app-service+jwt`, minted via
   * `POST /auth/api/apps/token/service` — no user, no attestation, no
   * consent event behind it) may carry this scope (#1803).
   *
   * Defaults to `false` — fail-closed, the same pattern as `credentialFree`
   * below. A scope nobody has explicitly signed off on as service-eligible is
   * assumed to require a human consent event, and must never reach a service
   * token even when the app's own `requestedScopes` lists it.
   *
   * This shipped with the fence empty (#1803): no scope was marked
   * `serviceEligible` while the per-lot `channel_links` gate did not exist yet.
   * catalyst-power/xprize#70 flips `supply:read` on now that it does — a
   * service token may carry the scope, but `handleLotGet` still requires an
   * active `channel_links` grant of `supply:read` from the lot's originating
   * supplier before it will return a lot, and every read writes an audit row.
   * `supply:write` stays ineligible.
   */
  serviceEligible?: boolean;
}

/**
 * A platform scope with no owning connector: granted to registered apps through
 * the OAuth consent screen, never through a connector scope-manifest.
 */
export interface PlatformScopeEntry extends BaseScopeEntry {
  connector: null;
}

/**
 * A connector-owned scope. Appears in that connector's signed scope-manifest,
 * in its POST validator, and as a toggle on its connector card.
 */
export interface ConnectorScopeEntry extends BaseScopeEntry {
  connector: ConnectorId;
  /** Manifest descriptor `verb`, e.g. `read` / `write` / `execute`. */
  verb: string;
  /** Manifest descriptor `surface`, e.g. `media` / `repos`. */
  surface: string;
  /**
   * Label written into the signed scope-manifest asset. Defaults to `label`.
   *
   * Kept separate because manifest bytes are signed: changing this text
   * rewrites every existing owner's manifest on their next publish.
   */
  manifestLabel?: string;
  /** Label on the connector card. Defaults to `manifestLabel ?? label`. */
  uiLabel?: string;
  /** The #1196 2×2 inputs. */
  classification: ScopeClassification;
  /**
   * Explicit tier that overrides the 2×2 derivation. Only ever used to
   * *tighten* — e.g. `media:write` is not disclosing and not sensitive (so the
   * 2×2 says `silent`) but we still demand explicit consent.
   */
  releaseOverride?: ScopeReleaseOverride;
  /**
   * True when exercising this scope consumes NO sealed credential (#1679).
   *
   * Independent of the 2×2, which says what releasing the scope discloses, not
   * what exercising it spends. `github:read` is `silent` and still needs the
   * owner's GitHub token; `discovery:read` is `silent` and needs nothing at all.
   *
   * The distinction is load-bearing on a connector that ingests a credential:
   * its card gates every toggle behind the credential step, so a credential-free
   * scope parked there is ungrantable until the owner seals a key they will
   * never use. That is exactly how #1679 stranded `discovery:read` on the Warp
   * card. Marking a scope here lets the card grant it on its own terms.
   *
   * Omit it (the default) for anything that reads or writes through a sealed
   * credential — fail-closed, so a forgotten flag costs a toggle, not a leak.
   */
  credentialFree?: boolean;
}

export type ScopeVocabularyEntry = PlatformScopeEntry | ConnectorScopeEntry;

// ── The four #1196 quadrants, named ────────────────────────────────────────
//
// Naming the quadrants means a reader sees the *meaning* of a classification
// rather than having to apply the 2×2 to a pair of booleans. The derived tier is
// noted on each; `deriveScopeReleaseTier` is what actually computes it.

/** Owner's own data, nothing sensitive → `silent`. */
const SELF_ONLY: ScopeClassification = { disclosesOthers: false, sensitive: false };
/** Exposes other people → `on-consent`. */
const TOUCHES_OTHERS: ScopeClassification = { disclosesOthers: true, sensitive: false };
/** Owner's own credential-grade material → `owner-only`. */
const SELF_SENSITIVE: ScopeClassification = { disclosesOthers: false, sensitive: true };
/** Both axes → `never`: a structural drop, hidden from the UI. */
const TOUCHES_OTHERS_SENSITIVE: ScopeClassification = { disclosesOthers: true, sensitive: true };

/** Carried by MCP access tokens (the capability ceiling, not a grant). */
const MCP_TOKENS: readonly CapabilitySurface[] = ['mcp'];

/**
 * Shared shape for the `*:infer` "brain" scopes (Gemini, Anthropic, xAI,
 * OpenAI, Moonshot, …): each lets a DID seal one inference provider's own API
 * key, spent on every call and never released to a third party → SELF_SENSITIVE
 * → owner-only under the #1196 2×2. Every one of these entries used to be a
 * hand-copied object literal differing only in the connector id, surface, and
 * label — structurally identical enough that SonarCloud's duplication
 * detector flagged the copies (#1930). Extracting the shape once here is the
 * `SCOPE_VOCABULARY` counterpart to `brainConnectorEntry()` in
 * connector-registry.ts: the Nth brain becomes one call, not another entry
 * for CPD to match against the last four.
 *
 * `C extends ConnectorId` keeps `scope` a template-literal type (`` `${C}:infer` ``)
 * rather than widening to `string`, so `Scope` (derived from
 * `SCOPE_VOCABULARY[number]['scope']`) still carries each exact scope string.
 */
function brainInferScope<C extends ConnectorId>(
  connector: C,
  surface: string,
  label: string,
): { scope: `${C}:infer`; connector: C; verb: 'infer'; surface: string; classification: ScopeClassification; label: string } {
  return { scope: `${connector}:infer`, connector, verb: 'infer', surface, classification: SELF_SENSITIVE, label };
}

// ── The vocabulary ────────────────────────────────────────────────────────

/**
 * THE source of truth — one row per scope.
 *
 * Order matters: it determines consent-screen ordering, `scopes_supported` in
 * the OAuth discovery docs, and connector-card toggle order. Append rather than
 * reorder unless you mean to change those.
 *
 * Rows are deliberately dense so the table reads as a table. Connector rows put
 * machine-readable facts on the first line and human-facing prose on the second:
 *   line 1 — scope, owning connector, manifest verb/surface, classification, surfaces
 *   line 2 — consent label, and the manifest/UI labels where they differ
 */
export const SCOPE_VOCABULARY = [
  // ── Platform scopes — no owning connector, granted via the OAuth consent screen
  { scope: 'profile:read', connector: null, label: 'Read your profile information' },
  { scope: 'identity:read', connector: null, label: 'Read your identity and DID' },
  { scope: 'identity:write', connector: null, label: 'Resolve or mint soft identities on your behalf (registry get-or-create)' },
  { scope: 'connectors:read-status', connector: null, label: 'Read your connector connection status' },
  // #1799: powers the per-connector usage rollup (attestations + signed connector
  // actions, scoped to the connector's registered scope(s)) — distinct from
  // connectors:read-status, which only ever answers connected/not-connected.
  { scope: 'connectors:read-telemetry', connector: null, label: 'Read your connector usage telemetry' },
  // #1677: telemetry ingestion pattern — a registered app (Delegated App
  // Sessions, #244) reports structured usage events from an external tool,
  // attributed to the delegating DID via the app's own consent grant.
  // Platform scopes (no owning connector) rather than a `CONNECTOR_REGISTRY`
  // entry: attribution is anchored to the app's delegated-app grant, not a
  // per-DID sealed credential, so there is no card/credential step to model —
  // the same shape `connections:write` already uses for POST
  // /connections/api/invites. `telemetry:write` gates the ingestion endpoint;
  // `telemetry:read` gates the caller's own usage projection on the same route.
  { scope: 'telemetry:write', connector: null, label: 'Report structured usage telemetry on your behalf' },
  { scope: 'telemetry:read', connector: null, label: 'Read your usage telemetry' },

  // ── MCP / Claude connector
  { scope: 'media:read', connector: 'mcp', verb: 'read', surface: 'media', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read your media library (files, folders, and metadata)', manifestLabel: 'Read your media assets' },
  // Tightened: writing on someone's behalf always warrants explicit consent.
  { scope: 'media:write', connector: 'mcp', verb: 'write', surface: 'media', classification: SELF_ONLY, surfaces: MCP_TOKENS, releaseOverride: 'on-consent',
    label: 'Create and upload media on your behalf', manifestLabel: 'Create and update your media assets' },
  // Crosses the sovereignty boundary — distinct from media:write.
  { scope: 'media:share', connector: 'mcp', verb: 'write', surface: 'media-access', classification: TOUCHES_OTHERS, surfaces: MCP_TOKENS,
    label: 'Share your media with other people', manifestLabel: "Grant or revoke other people's access to your assets" },

  { scope: 'wallet:read', connector: null, label: 'View your wallet balance and transaction history' },
  { scope: 'wallet:write', connector: null, label: 'Create payments and transfers on your behalf' },

  { scope: 'connections:read', connector: 'mcp', verb: 'read', surface: 'connections', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'View your connections', manifestLabel: 'Read your trust-graph connections' },
  // Platform scope (#1793): consumed directly via requireAppAuth() on
  // POST /connections/api/invites, the same way wallet:write gates
  // POST /pay/api/checkout — not an MCP tool surface, so no owning connector.
  { scope: 'connections:write', connector: null, label: 'Create invites on your behalf' },

  // Platform scope (#1823): same shape as connections:write — a registered
  // app creates conversations / sends messages on the delegating user's
  // behalf (e.g. a counterparty delivery notification), not through an MCP
  // tool surface, so no owning connector. Distinct from the MCP-owned
  // `messages:write` below, which gates the MCP send-message tool.
  { scope: 'chat:write', connector: null, label: 'Create conversations and send messages on your behalf' },

  { scope: 'events:read', connector: null, label: 'View events you attend or have created' },
  { scope: 'events:write', connector: null, label: 'Create and manage events on your behalf' },
  // #1803 shipped this ineligible; catalyst-power/xprize#70 flips it on now that
  // the per-lot gate is live: even service-eligible, every app-token lot read
  // still requires an active channel_links grant of supply:read from the lot's
  // originating supplier (`handleLotGet` in apps/kernel/src/lib/supply.ts), and
  // every read writes a DID-attributed audit row. supply:write stays ineligible.
  { scope: 'supply:read', connector: null, label: 'View your supply-chain lots and their stage history', serviceEligible: true },
  { scope: 'supply:write', connector: null, label: 'Record supply-chain stages (declare, collect, process, list) on your behalf' },

  { scope: 'messages:read', connector: 'mcp', verb: 'read', surface: 'messages', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read messages in your conversations', manifestLabel: 'List your conversations and read their messages' },
  // Tightened: sends onBehalfOf the human.
  { scope: 'messages:write', connector: 'mcp', verb: 'write', surface: 'messages', classification: SELF_ONLY, surfaces: MCP_TOKENS, releaseOverride: 'on-consent',
    label: 'Send messages on your behalf', manifestLabel: 'Send messages in your conversations on your behalf' },

  { scope: 'attestations:read', connector: null, label: 'View your attestations and reputation' },
  { scope: 'attestations:write', connector: null, label: 'Issue attestations on your behalf' },
  { scope: 'availability:read', connector: null, label: 'View your availability and coordination intents' },
  { scope: 'availability:write', connector: null, label: 'Set and cancel availability intents on your behalf' },
  { scope: 'infer:provide', connector: null, label: 'Provide app-owned inference credentials for delegated inference' },
  // #1925: gates POST /infer/v1/chat/completions, the OpenAI-compatible
  // completions passthrough. Distinct from `infer:provide` (which lets an app
  // supply its OWN credential for delegated inference): this scope lets an
  // app call the passthrough onBehalfOf a principal whose sealed connector
  // card (BRAIN_CONNECTORS) supplies the model. Platform scope — the
  // passthrough is a kernel route, not a connector card, so there is no
  // owning connector to gate a manifest toggle on.
  { scope: 'infer:completions', connector: null, label: 'Use the completions passthrough for inference on your behalf' },
  // #1923: gates the per-connector spend burn-down dashboard read
  // (`GET /connections/api/connectors/:id/spend`) — distinct from
  // `connectors:read-telemetry` (attestation/signed-action counts), since
  // this reads token/cost figures out of `inference.usage` instead.
  { scope: 'infer:usage-read', connector: null, label: 'Read your inference spend and usage burn-down' },

  // #1151: gates POST /usage/api/incurred, the emitter-registry ingest door
  // external adapters (Claude Code, Warp, ...) use to write into the shared
  // usage.incurred stream (#1147). Platform scope — ingestion is a kernel
  // route, not a connector card. serviceEligible: true because the reference
  // Claude Code adapter authenticates as itself via an app-service token
  // (docs/guide/service-credentials.md), with no delegating human session in
  // the loop when it tails a local log unattended.
  { scope: 'usage:emit', connector: null, label: 'Emit usage/spend records on behalf of a registered emitter', serviceEligible: true },
  // #1151: gates GET/PUT /usage/api/emitters, the emitter registry itself.
  // Owner-only by construction — the route only ever lets a caller list or
  // upsert rows whose issuer_did equals their own effective DID — so there is
  // no classification axis to derive a release tier from (same shape as
  // infer:usage-read: platform scope, nothing released to a third party).
  { scope: 'usage:emitters-manage', connector: null, label: 'Register and manage your usage emitters' },

  // ── QuickBooks connector — invoices are sent to customers, hence write touches others
  { scope: 'quickbooks:read', connector: 'quickbooks', verb: 'read', surface: 'invoices', classification: SELF_ONLY,
    label: 'Read your QuickBooks invoices as supply-chain settlement signals', manifestLabel: 'Read your QuickBooks invoices' },
  { scope: 'quickbooks:write', connector: 'quickbooks', verb: 'write', surface: 'invoices', classification: TOUCHES_OTHERS,
    label: 'Create QuickBooks invoices on your behalf (supply-chain settlement)', manifestLabel: 'Create QuickBooks invoices' },

  // ── GitHub connector
  { scope: 'github:read', connector: 'github', verb: 'read', surface: 'repos', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read your repos, issues and PRs on GitHub', manifestLabel: 'Read your own repos, issues and PRs', uiLabel: 'Read your repos, issues and PRs' },
  { scope: 'github:write', connector: 'github', verb: 'write', surface: 'issues', classification: SELF_ONLY, surfaces: MCP_TOKENS, releaseOverride: 'on-consent',
    label: 'Open and comment on issues & PRs on your GitHub repos', manifestLabel: 'Open and comment on issues & PRs on your repos', uiLabel: 'Create issues and comments on your repos' },
  { scope: 'github:org', connector: 'github', verb: 'write', surface: 'org', classification: TOUCHES_OTHERS, surfaces: MCP_TOKENS,
    label: 'Act on repos owned by an org or other people on GitHub', manifestLabel: 'Act on repos owned by an org or other people' },
  { scope: 'github:actions', connector: 'github', verb: 'execute', surface: 'actions', classification: TOUCHES_OTHERS_SENSITIVE, surfaces: MCP_TOKENS,
    label: 'Trigger GitHub Actions / deploy / spend CI minutes', manifestLabel: 'Trigger Actions / deploy / spend CI minutes' },

  // ── Discord connector — both scopes act on shared channels, so both touch others
  { scope: 'discord:post', connector: 'discord', verb: 'post', surface: 'channels', classification: TOUCHES_OTHERS,
    label: 'Post messages to Discord channels on your behalf', manifestLabel: 'Post messages to Discord channels' },
  { scope: 'discord:read', connector: 'discord', verb: 'read', surface: 'channels', classification: TOUCHES_OTHERS,
    label: 'Read messages from Discord channels on your behalf', manifestLabel: 'Read messages from Discord channels' },

  // ── Brain connectors — sealed inference-provider API keys, one call each
  // via `brainInferScope` (see its doc comment). Order is the ONLY thing that
  // still needs stating per entry: Gemini (#1432) was first and is why
  // gemini:infer predates the #1253 vocabulary; Anthropic (#1621) is second;
  // xAI (#1924) is third — the net-new provider the #1922 passthrough is
  // validated on first (Grok → OpenAI → Gemini, Anthropic last); OpenAI
  // (#1927) is fourth, and the reference dialect for the OpenAI-compatible
  // passthrough (#1925); Moonshot AI/Kimi (#1930) is fifth, OpenAI-compatible
  // and pointed at api.moonshot.ai — Kimi is OpenClaw's live coding-agent
  // workhorse today, the connector this recurring spend moves onto a sealed
  // credential first; Z.ai/GLM (#1931) is sixth, capability-completion with
  // no current spend (lowest priority of the provider entries).
  brainInferScope('gemini', 'gemini-api', 'Use your Gemini API key for inference'),
  brainInferScope('anthropic', 'anthropic-api', 'Use your Anthropic API key for inference'),
  brainInferScope('xai', 'xai-api', 'Use your xAI API key for inference'),
  brainInferScope('openai', 'openai-api', 'Use your OpenAI API key for inference'),
  brainInferScope('moonshot', 'moonshot-api', 'Use your Moonshot API key for inference'),
  brainInferScope('zai', 'zai-api', 'Use your Z.ai API key for inference'),

  // ── Google Cloud connector (#1317) — a sealed service-account key, not an
  // inference-only brain. The key is the owner's own credential and is consumed
  // server-side on every call, never handed to a third party → SELF_SENSITIVE →
  // owner-only, same quadrant as gemini:infer.
  //
  // These are the only three scopes Stage 1 opens, deliberately: a service
  // account key is broad, so the grant that unseals it must not be. Each names
  // one GCP surface (`iam`, `vertex`, `project`) in the verb, which is why these
  // scope strings carry a third segment where every other connector's carry two.
  { scope: 'gcp:iam:read', connector: 'gcp', verb: 'iam:read', surface: 'gcp-api', classification: SELF_SENSITIVE,
    label: 'Read IAM policies and service accounts' },
  { scope: 'gcp:vertex:invoke', connector: 'gcp', verb: 'vertex:invoke', surface: 'gcp-api', classification: SELF_SENSITIVE,
    label: 'Invoke Vertex AI / Gemini models' },
  { scope: 'gcp:project:read', connector: 'gcp', verb: 'project:read', surface: 'gcp-api', classification: SELF_SENSITIVE,
    label: 'Read GCP project metadata' },

  // ── Warp connector (#1428) — per-DID Warp Cloud Agent key.
  // Consumes the owner's own sealed Agent key to spawn cloud agents under their
  // service-account identity → SELF_SENSITIVE → owner-only. Carried by MCP
  // tokens so a `{username}-jin` speaking MCP can dispatch (Wire B), which is
  // the whole point: the credential individuates the dispatch.
  { scope: 'warp:dispatch', connector: 'warp', verb: 'dispatch', surface: 'cloud-agents', classification: SELF_SENSITIVE, surfaces: MCP_TOKENS,
    label: 'Dispatch Warp cloud agents using your sealed Warp Agent key', manifestLabel: 'Dispatch Warp cloud agents under your own credential' },

  // ── Stripe connector (#1785) — BYO restricted-key, Connect deliberately
  // bypassed. The owner's own sealed restricted key self-provisions a webhook
  // endpoint and is consumed to verify and republish their own Stripe events
  // onto the bus. Never released to a third party → SELF_SENSITIVE →
  // owner-only, same quadrant as gemini:infer / warp:dispatch.
  { scope: 'stripe:events', connector: 'stripe', verb: 'events', surface: 'payments', classification: SELF_SENSITIVE,
    label: 'Publish your Stripe payment events (payments, invoices, payouts) to your reactor chains',
    manifestLabel: 'Publish your own Stripe payment events onto the bus' },

  // ── Discovery (#1636, re-homed onto `mcp` by #1679)
  //
  // Read-only self-description of the node: the OpenAPI specs it serves, the
  // scope vocabulary itself, and the caller's OWN connector grant state. An
  // agent that can read these starts from what the system actually exposes
  // instead of grepping source and guessing, which is where the stale
  // assumptions — and the failed PRs — come from.
  //
  // SELF_ONLY → `silent`: every byte is either already public (the specs) or the
  // owner's own connector state, and nothing here is credential-grade. Reads
  // only; there is no write counterpart, by design (writes go through git/PR).
  //
  // #1636 put it on the Warp connector because a dispatched cloud agent was the
  // caller that needed it. That coupled a credential-free scope to a
  // credential-ingesting card: the Warp card only publishes a manifest once the
  // owner seals an Agent key, so a `silent` scope that needs no key at all could
  // not materialise without one. #1679 moves it to the native `mcp` connector —
  // which has no credential step — and marks it `credentialFree` so the coupling
  // cannot silently come back. Ownership moved; the read surface did not: it is
  // still reached over MCP, by the same MCP tools, under the same scope string.
  { scope: 'discovery:read', connector: 'mcp', verb: 'read', surface: 'discovery', classification: SELF_ONLY, surfaces: MCP_TOKENS, credentialFree: true,
    label: 'Read Imajin API specs, the scope vocabulary, and your connector status',
    manifestLabel: 'Read the node API specs, scope vocabulary, and your connector status',
    uiLabel: 'Read API specs, scope vocabulary, and your connector status' },

  // ── MCP inference surface (#1298) — decoupled from media:*
  //
  // The inference MCP tools used to gate on `media:write` / `media:read`, so any
  // agent that could upload a file could also run the intention-inference
  // pipeline and have a supply attestation signed on the owner's behalf. These
  // are MCP-surface scopes, not provider scopes: `gemini:infer` /
  // `anthropic:infer` stay where they are, since those name whose API key gets
  // spent, not who may drive the pipeline.
  //
  // Appended rather than slotted into the MCP block above so the externally
  // visible `scopes_supported` ordering only grows at the tail.
  { scope: 'inference:read', connector: 'mcp', verb: 'read', surface: 'inference', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read inference session results', manifestLabel: 'Read inference session status and attestations' },
  // Signs attestations on the owner's behalf — same quadrant as `gemini:infer`
  // (SELF_SENSITIVE), so the 2×2 derives `owner-only` and publishing it writes a
  // consent row. Deliberately stricter than `media:write`'s on-consent override.
  { scope: 'inference:write', connector: 'mcp', verb: 'write', surface: 'inference', classification: SELF_SENSITIVE, surfaces: MCP_TOKENS,
    label: 'Trigger inference and sign attestations', manifestLabel: 'Trigger the inference pipeline and sign attestations on your behalf' },

  // ── Corpus proxy tools (#1730)
  //
  // The kernel MCP surface auth-gates these scopes, then proxies to the
  // out-of-process corpus engine. The corpus stores and searches only the
  // owner's own indexed threads for the effective DID; it consumes no sealed
  // external credential, so it is owned by the native MCP connector.
  { scope: 'corpus:read', connector: 'mcp', verb: 'read', surface: 'corpus', classification: SELF_ONLY, surfaces: MCP_TOKENS, credentialFree: true,
    label: 'Read and search the corpus', manifestLabel: 'Read and search your corpus' },
  { scope: 'corpus:write', connector: 'mcp', verb: 'write', surface: 'corpus', classification: SELF_ONLY, surfaces: MCP_TOKENS, releaseOverride: 'on-consent', credentialFree: true,
    label: 'Load and sync corpus sources', manifestLabel: 'Load and sync your corpus sources' },

  // ── Generic consent-request primitive (#1817) — platform scope, no owning
  // connector. Generalizes the inference confirm gate (#1782/#1784/#1791) for
  // any app-authed requester: gates raising a consent.requested bus event that
  // renders as a confirm card on /jin for an explicit approver DID. Holding
  // this scope only authorizes RAISING a request — the approver's own signed
  // decision (approval.decision) is the sole path to an approve/reject outcome;
  // there is deliberately no auto-approval or standing-approval policy here.
  { scope: 'consent:write', connector: null, label: 'Raise consent requests for another identity to approve on your behalf' },
] as const satisfies readonly ScopeVocabularyEntry[];

/** Every scope string in the vocabulary, as a literal union. */
export type Scope = (typeof SCOPE_VOCABULARY)[number]['scope'];

/** Widened view for runtime iteration and narrowing. */
const ENTRIES: readonly ScopeVocabularyEntry[] = SCOPE_VOCABULARY;

// ── Derivation ────────────────────────────────────────────────────────────────

/** True for entries owned by a connector (narrows the union). */
export function isConnectorScope(entry: ScopeVocabularyEntry): entry is ConnectorScopeEntry {
  return entry.connector !== null;
}

/**
 * Resolve a scope's release tier from the #1196 2×2, honouring an explicit
 * override. Semantics match `deriveReleaseTier` in `@imajin/fair`; a
 * conformance test pins the two together across all four quadrants.
 */
export function deriveScopeReleaseTier(entry: ConnectorScopeEntry): ScopeReleaseTier {
  if (entry.releaseOverride) return entry.releaseOverride;
  const { disclosesOthers, sensitive } = entry.classification;
  if (!disclosesOthers && !sensitive) return 'silent';
  if (disclosesOthers && !sensitive) return 'on-consent';
  if (!disclosesOthers && sensitive) return 'owner-only';
  return 'never';
}

/**
 * The `viewer` recorded in the manifest release block, or undefined.
 *
 * Derived rather than declared: a viewer is meaningful exactly when the scope
 * is released to the connector under a consent barrier. `silent` scopes need no
 * named viewer, and `never` scopes are never released to anyone.
 */
export function viewerForScope(entry: ConnectorScopeEntry): string | undefined {
  const tier = deriveScopeReleaseTier(entry);
  if (tier === 'on-consent' || tier === 'owner-only') return CONNECTOR_DIDS[entry.connector];
  return undefined;
}

/** Label shown on the connector card. */
export function uiLabelForScope(entry: ConnectorScopeEntry): string {
  return entry.uiLabel ?? entry.manifestLabel ?? entry.label;
}

/** Label written into the signed scope-manifest asset. */
export function manifestLabelForScope(entry: ConnectorScopeEntry): string {
  return entry.manifestLabel ?? entry.label;
}

/**
 * True when exercising this scope consumes no sealed credential (#1679).
 *
 * Defaults to false, which is the fail-closed reading: a scope nobody has
 * thought about is assumed to spend the connector's credential.
 */
export function isCredentialFreeScope(entry: ConnectorScopeEntry): boolean {
  return entry.credentialFree === true;
}

/**
 * True when a session-less service token may carry this scope (#1803).
 *
 * Defaults to false — fail-closed. See `BaseScopeEntry.serviceEligible` for
 * the full rationale.
 */
export function isServiceEligibleScope(entry: ScopeVocabularyEntry): boolean {
  return entry.serviceEligible === true;
}

/**
 * Every scope string a session-less service token (`app-service+jwt`) may
 * carry, in vocabulary order (#1803). This is the fence
 * `POST /auth/api/apps/token/service` clamps against — the intersection of
 * this set and an app's own `requestedScopes` is what actually gets minted.
 *
 * `supply:read` is the first (and, as of catalyst-power/xprize#70, only)
 * scope signed off on as service-eligible; every other scope stays fenced
 * out until explicitly flipped.
 */
export function serviceEligibleScopes(): readonly string[] {
  return ENTRIES.filter(isServiceEligibleScope).map((e) => e.scope);
}

// ── Lookups ───────────────────────────────────────────────────────────────────

const BY_SCOPE = new Map<string, ScopeVocabularyEntry>(ENTRIES.map((e) => [e.scope, e]));

/** Look up one entry, or undefined for an unknown scope string. */
export function scopeEntry(scope: string): ScopeVocabularyEntry | undefined {
  return BY_SCOPE.get(scope);
}

/** True iff the scope exists in the vocabulary. */
export function isKnownScope(scope: string): scope is Scope {
  return BY_SCOPE.has(scope);
}

/** Every entry owned by `connector`, in vocabulary order. */
export function scopesForConnector(connector: ConnectorId): readonly ConnectorScopeEntry[] {
  return ENTRIES.filter(isConnectorScope).filter((e) => e.connector === connector);
}

/**
 * Every scope string a token for `surface` may carry, in vocabulary order.
 * This is the capability ceiling — not a grant.
 */
export function scopesForSurface(surface: CapabilitySurface): readonly string[] {
  return ENTRIES.filter((e) => e.surfaces?.includes(surface) ?? false).map((e) => e.scope);
}

/** All scope strings, in vocabulary order. */
export function allScopes(): readonly Scope[] {
  return ENTRIES.map((e) => e.scope as Scope);
}
