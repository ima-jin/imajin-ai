/**
 * Warp Cloud Agent dispatch client (#1428).
 *
 * The wire: caller DID → active `warp:dispatch` grant → unwrap *their* sealed
 * Warp Agent key → `POST /agent/run` stamped `{username}-jin`.
 *
 * Every run is fired with the caller's own credential, so Warp attributes it to
 * that key's service account. Nothing here has to enforce "don't puppet the
 * human" — the credential does it structurally.
 *
 * ## Secret handling
 * The Agent key is read inside `dispatchAgentRun` / `getAgentRun`, used as a
 * Bearer header, and dropped. It is never logged, never placed in a thrown
 * message, never returned, and never written to the bus event. Warp errors are
 * mapped to {@link WarpApiError} carrying only RFC-7807 problem metadata, so a
 * failed request can be surfaced to a caller verbatim without leaking anything.
 *
 * ## Verified request shape
 * `POST {base}/agent/run` takes `{ prompt, title?, config? }` where `config` is
 * Warp's `AmbientAgentConfig`. Note `config.mcp_servers` is a **map** of name →
 * server config, not an array. `GET {base}/agent/runs/{runId}` returns the run's
 * lifecycle state and `session_link`.
 *
 * ## Surface (#1639)
 * Every call below is the same wire — caller DID → `warp:dispatch` grant →
 * *their* sealed key — so a caller can only ever reach runs its own credential
 * created. Reads and mutations are gated by the one scope for that reason:
 * there is no cross-DID surface to grant separately.
 *   - `GET  /agent/runs/{runId}`             → {@link getAgentRun}
 *   - `GET  /agent/runs/{runId}/transcript`  → {@link getAgentRunTranscript}
 *   - `GET  /agent/runs/{runId}/conversation`→ {@link getAgentRunConversation}
 *   - `GET  /agent/runs`                     → {@link listAgentRuns}
 *   - `POST /agent/runs/{runId}/cancel`      → {@link cancelAgentRun}
 *   - `POST /agent/runs/{runId}/followups`   → {@link sendFollowup}
 *
 * ## Completion watch (#1639, Stage 3)
 * Warp publishes no webhooks, so {@link watchRun} polls a dispatched run until it
 * stops and puts the outcome on the bus as `warp.run.completed` (or
 * `warp.run.timeout`). That is what turns dispatch from "fire and poll by hand"
 * into a closed loop.
 */
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { lookupIdentity } from '@/src/lib/kernel/lookup';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { getMcpResource } from '@/src/lib/mcp/oauth-config';
import { requireAgentKey } from './connector';
import { readEnvironmentId } from './environment';
import { WarpApiError } from './errors';

// Re-exported so callers of the client get the error type from one import; the
// class itself lives in ./errors so the route mapping can import it without
// pulling in this module's DB-backed identity lookup.
export { WarpApiError };

const log = createLogger('kernel');

const DEFAULT_WARP_API_BASE_URL = 'https://app.warp.dev/api/v1';

/**
 * Drop every trailing `char`.
 *
 * Index walking rather than a regex: the obvious patterns for this (`/\/+$/`,
 * `/^-+|-+$/`) are anchored quantifiers that backtrack super-linearly, and both
 * call sites take externally-influenced input (a configured base URL, a handle).
 * A linear scan removes the need to reason about that at all.
 */
function trimTrailing(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Drop every leading and trailing `char`. See {@link trimTrailing}. */
function trimSurrounding(value: string, char: string): string {
  let start = 0;
  while (start < value.length && value[start] === char) {
    start += 1;
  }
  return trimTrailing(value.slice(start), char);
}

/** Warp REST base URL. Overridable so tests never point at the real platform. */
function warpApiBaseUrl(): string {
  const configured = process.env.WARP_API_BASE_URL?.trim();
  const base = configured && configured.length > 0 ? configured : DEFAULT_WARP_API_BASE_URL;
  return trimTrailing(base, '/');
}

/**
 * Environment a dispatch lands in, resolved highest-precedence first:
 *   1. `perCall` — this dispatch explicitly named one.
 *   2. the caller's own stored default (`warp-environment-id:{principalDid}`).
 *   3. the node DID's stored default — the node-wide setting.
 *   4. undefined ⇒ `environment_id` is omitted and Warp applies its own default.
 *
 * There is no env var in this chain by design (#1632): configuration belongs to a
 * DID, so the node-wide default is just the node's own stored field rather than a
 * second, process-scoped mechanism that no connector card could show or change.
 *
 * The node lookup is skipped whenever it cannot change the answer — the caller
 * already has a value, the caller *is* the node, or the node DID is unresolvable.
 * A failure reading it degrades to "no default": a preference must never be able
 * to fail a dispatch that is otherwise fully authorized.
 */
async function resolveEnvironmentId(
  principalDid: string,
  perCall: string | undefined,
): Promise<string | undefined> {
  if (perCall !== undefined) return perCall;

  const own = await readEnvironmentId(principalDid);
  if (own !== undefined) return own;

  let nodeDid = '';
  try {
    nodeDid = await getNodeDid();
  } catch (err) {
    log.warn({ err: String(err) }, 'Could not resolve node DID for Warp environment default');
    return undefined;
  }

  if (nodeDid.length === 0 || nodeDid === principalDid) return undefined;
  return readEnvironmentId(nodeDid);
}

// ── Types (mirroring Warp's published schema) ────────────────────────────────

/** One MCP server on the dispatched agent. Exactly one transport field is set. */
export interface WarpMcpServerConfig {
  /** SSE/HTTP transport — server URL. */
  url?: string;
  /** Stdio transport — command to run. */
  command?: string;
  /** Stdio transport — command arguments. */
  args?: string[];
  /** Environment variables for the server. */
  env?: Record<string, string>;
  /** HTTP headers for SSE/HTTP transport (e.g. an Authorization bearer). */
  headers?: Record<string, string>;
  /** Reference to a Warp shared MCP server by UUID. */
  warp_id?: string;
}

/** Warp `AmbientAgentConfig` — the subset this wire sends. */
interface WarpAgentConfig {
  name?: string;
  model_id?: string;
  base_prompt?: string;
  environment_id?: string;
  skill_spec?: string;
  mcp_servers?: Record<string, WarpMcpServerConfig>;
  computer_use_enabled?: boolean;
}

export interface DispatchAgentRunInput {
  /** The task for the cloud agent. Required and non-empty. */
  prompt: string;
  /** Human-readable run title. */
  title?: string;
  /**
   * `config.name` traceability tag. Defaults to `{username}-jin` for the caller,
   * which is the audit trail this issue exists to create — override only when a
   * caller genuinely needs to group runs under a different label.
   */
  name?: string;
  modelId?: string;
  basePrompt?: string;
  /**
   * Cloud environment UID for this run. Omit to inherit the caller's stored
   * default, then the node's — see {@link resolveEnvironmentId}.
   */
  environmentId?: string;
  /**
   * Skill to use as the base prompt, `owner/repo:skill-name` or
   * `owner/repo:path/to/SKILL.md`. A versioned SKILL.md in the repo becomes the
   * dispatchable payload instead of a pasted prompt blob.
   */
  skillSpec?: string;
  /** Extra MCP servers, keyed by name. Merged over the imajin default. */
  mcpServers?: Record<string, WarpMcpServerConfig>;
  /**
   * Attach `mcp.imajin.ai` so the dispatched agent acts through our primitives
   * (Wire B).
   *
   * Off by default: our MCP surface is OAuth-protected, so an attached server
   * with no credential is a server the agent cannot use. Opt in and supply the
   * agent's own token via `mcpServers.imajin.headers` when it holds one.
   */
  attachImajinMcp?: boolean;
  computerUseEnabled?: boolean;
}

/** Warp `RunStatusMessage` — why a run is in the state it is in. */
export interface WarpRunStatusMessage {
  message: string;
  /**
   * Warp's machine-readable `PlatformErrorCode`, present on terminal error
   * states. This is the field that makes a failed run self-diagnosable without
   * pulling the transcript.
   */
  errorCode: string | null;
  retryable: boolean | null;
}

/** Warp `RequestUsage` — what the run cost, in Warp's own units. */
export interface WarpRunUsage {
  inferenceCost: number | null;
  computeCost: number | null;
  platformCost: number | null;
}

/**
 * Warp `RunCreatorInfo`, reduced to identity.
 *
 * `email` and `photo_url` are deliberately dropped: nothing downstream of a run
 * read needs them, and a field we do not parse is a field that cannot end up in
 * a log line or a bus payload later.
 */
export interface WarpRunPrincipal {
  /** `user` or `service_account`. */
  type: string | null;
  uid: string | null;
  displayName: string | null;
}

/**
 * One artifact a run produced — a plan, a pull request, a screenshot, a file.
 *
 * `data` is Warp's own per-type object passed through unchanged (they own the
 * discriminated union; re-modelling it here would only drift). For a
 * `PULL_REQUEST` artifact it carries `{ url, branch }`, which is the PR linkage
 * that previously had to be found by searching GitHub by hand.
 */
export interface WarpRunArtifact {
  artifactType: string | null;
  createdAt: string | null;
  data: Record<string, unknown> | null;
}

/** Warp `AgentSkill` — the skill a run executed, when it ran one. */
export interface WarpRunSkill {
  name: string | null;
  /** Path to the SKILL.md, for file-based skills. */
  fullPath: string | null;
  /** Identifier, for Warp's bundled skills. */
  bundledSkillId: string | null;
}

/** Warp `ScheduleInfo` — only present on scheduled runs. */
export interface WarpRunSchedule {
  scheduleId: string | null;
  scheduleName: string | null;
  cronSchedule: string | null;
}

/**
 * What a caller learns about a run. Never includes credential material.
 *
 * The prompt is deliberately **not** parsed even though `GET /agent/runs/{runId}`
 * returns it (#1639). Keeping it out means a `WarpAgentRun` is safe to log and
 * safe to put on the bus wholesale — the same invariant `warp.agent.dispatched`
 * already relies on — so no caller has to re-audit which fields to strip.
 */
export interface WarpAgentRun {
  runId: string;
  state: string | null;
  sessionLink: string | null;
  title: string | null;
  configName: string | null;

  // ── #1639: the rest of what the same response already carried ──────────────

  /** RFC-3339. */
  createdAt: string | null;
  /** RFC-3339. */
  updatedAt: string | null;
  /** RFC-3339. Null until a worker picks the run up. */
  startedAt: string | null;
  /** Server-computed ISO-8601 duration, e.g. `PT2M30S` — the duration telemetry. */
  runTime: string | null;
  statusMessage: WarpRunStatusMessage | null;
  /** `API`, `SLACK`, `SCHEDULED_AGENT`, … */
  source: string | null;
  /** `LOCAL` or `REMOTE`. */
  executionLocation: string | null;
  sessionId: string | null;
  conversationId: string | null;
  parentRunId: string | null;
  /** Slack thread, Linear issue, or schedule that triggered the run. */
  triggerUrl: string | null;
  isSandboxRunning: boolean | null;
  requestUsage: WarpRunUsage | null;
  creator: WarpRunPrincipal | null;
  /** Who actually executed it — not always the creator (delegation). */
  executor: WarpRunPrincipal | null;
  /** Resolved from the run's `agent_config`. */
  modelId: string | null;
  /** Resolved from the run's `agent_config`. */
  environmentId: string | null;
  /** Resolved from the run's `agent_config`. */
  skillSpec: string | null;
  agentSkill: WarpRunSkill | null;
  schedule: WarpRunSchedule | null;
  /** Empty rather than null when the run produced nothing — callers iterate it. */
  artifacts: WarpRunArtifact[];
}

/** One page of {@link listAgentRuns} results. */
export interface WarpAgentRunPage {
  runs: WarpAgentRun[];
  hasNextPage: boolean;
  /** Opaque cursor to pass back as `cursor` for the next page. */
  nextCursor: string | null;
}

/**
 * Filters for {@link listAgentRuns}. Every field is optional; omitting all of
 * them lists the caller's most recently updated runs.
 */
export interface ListAgentRunsInput {
  /** Warp `config.name` — i.e. the `{username}-jin` tag a dispatch was stamped with. */
  name?: string;
  /** Match any of these run states (`QUEUED`, `INPROGRESS`, `SUCCEEDED`, …). */
  states?: string[];
  environmentId?: string;
  /** RFC-3339 lower bound on `created_at`. */
  createdAfter?: string;
  /** 1–500; Warp defaults to 20. Out-of-range values are clamped, not rejected. */
  limit?: number;
  /** `nextCursor` from a previous page. */
  cursor?: string;
}

/**
 * A run's raw transcript.
 *
 * The pre-signed download URL Warp redirects to is deliberately **not** returned:
 * it is a time-limited bearer capability for the transcript, so handing it back
 * would turn a scoped read into a shareable one.
 */
export interface WarpAgentRunTranscript {
  runId: string;
  content: string;
  /** Content type reported by the download, when it reported one. */
  contentType: string | null;
  /** True when `content` was cut at the size cap — see {@link TRANSCRIPT_MAX_CHARS}. */
  truncated: boolean;
}

/**
 * One block inside a normalized conversation message.
 *
 * `type` discriminates (`text`, `action`, `action_result`, `event`) and the rest
 * of the block is Warp's own snake_case shape, passed through. Warp owns that
 * union and extends it; mirroring it here would only drift, the same reasoning
 * the dispatch route applies to `mcp_servers`.
 */
export interface WarpConversationBlock {
  type: string;
  [field: string]: unknown;
}

/** One normalized message — `role` plus ordered content blocks. */
export interface WarpConversationMessage {
  role: string;
  content: WarpConversationBlock[];
  [field: string]: unknown;
}

/** A unit of work, with the nested steps any delegated work produced. */
export interface WarpConversationStep {
  id: string;
  messages: WarpConversationMessage[];
  steps: WarpConversationStep[];
  [field: string]: unknown;
}

/** Warp's normalized conversation for a run: messages, tool calls, and events. */
export interface WarpAgentRunConversation {
  runId: string;
  conversationId: string | null;
  steps: WarpConversationStep[];
}

/** Acknowledgement that Warp accepted a cancellation. */
export interface WarpAgentRunCancellation {
  runId: string;
  cancelled: true;
}

/**
 * Query mode for a follow-up. Warp does not infer this from a `/plan` prefix in
 * the message, so it has to be stated.
 */
export type WarpFollowupMode = 'normal' | 'plan' | 'orchestrate';

export interface SendFollowupInput {
  /** The message to deliver to the run. Required and non-empty. */
  message: string;
  /** Defaults to Warp's own default (`normal`) when omitted. */
  mode?: WarpFollowupMode;
}

/**
 * Acknowledgement that Warp accepted a follow-up.
 *
 * Deliberately not the resulting run state: Warp routes the message according to
 * whatever the run is doing and documents `GET /agent/runs/{runId}` as the way to
 * observe the effect, so inventing a state here would be a guess.
 */
export interface WarpFollowupAck {
  runId: string;
  accepted: true;
}

// ── Identity stamping ─────────────────────────────────────────────────────────

/** Strip a handle down to what Warp's `config.name` filter can round-trip. */
function slugify(value: string): string {
  const collapsed = value.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-');
  return trimSurrounding(collapsed, '-');
}

/**
 * The `{username}-jin` tag a dispatch is stamped with.
 *
 * Falls back to the DID's last segment when the identity has no handle: a
 * missing handle is a weaker audit trail, but an unlabelled run is worse than an
 * imperfectly labelled one, and dispatch must not fail over a cosmetic field.
 */
export async function resolveJinName(principalDid: string): Promise<string> {
  const identity = await lookupIdentity(principalDid);
  const handle = identity?.handle ? slugify(identity.handle) : '';
  if (handle.length > 0) {
    return `${handle}-jin`;
  }

  const segment = slugify(principalDid.split(':').at(-1) ?? '');
  return segment.length > 0 ? `${segment}-jin` : 'jin';
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

/** Shape of Warp's error body (RFC 7807 + backward-compatible members). */
interface WarpProblemBody {
  error?: unknown;
  title?: unknown;
  detail?: unknown;
  type?: unknown;
  retryable?: unknown;
  trace_id?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Finite numbers only — a NaN cost is worse than an absent one. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** A nested object, or null when the field is absent, null, or an array. */
function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The trimmed run id, or a `warp_invalid_run_id` throw.
 *
 * Every per-run call validates through here so a blank id fails before the
 * credential is unwrapped rather than becoming a 404 from Warp.
 */
function requireRunId(runId: string): string {
  const trimmed = runId.trim();
  if (trimmed.length === 0) {
    throw new Error('warp_invalid_run_id: runId must be a non-empty string');
  }
  return trimmed;
}

/**
 * Path for a sub-resource of a run.
 *
 * The id is always URL-encoded: it reaches us from a route parameter, and an
 * unencoded `../` would otherwise let a caller reshape the upstream path.
 */
function runPath(runId: string, suffix = ''): string {
  return `/agent/runs/${encodeURIComponent(runId)}${suffix}`;
}

/**
 * Machine-readable error code from a problem `type` URI.
 *
 * Warp documents `type` as
 * `https://docs.warp.dev/.../errors/{error_code}`, so the code is the last path
 * segment. Returns undefined rather than guessing when the URI is absent.
 */
function errorCodeFromType(type: unknown): string | undefined {
  const uri = optionalString(type);
  if (!uri) return undefined;
  return optionalString(uri.split('/').at(-1));
}

async function readProblem(response: Response): Promise<WarpApiError> {
  let body: WarpProblemBody = {};
  try {
    body = (await response.json()) as WarpProblemBody;
  } catch {
    // Non-JSON error body (proxy HTML, empty 502). The status alone is the signal.
  }

  const summary =
    optionalString(body.title) ?? optionalString(body.error) ?? response.statusText ?? 'request failed';

  return new WarpApiError(`warp_api_error: ${response.status} ${summary}`, {
    status: response.status,
    code: errorCodeFromType(body.type),
    detail: optionalString(body.detail),
    retryable: typeof body.retryable === 'boolean' ? body.retryable : undefined,
    traceId: optionalString(body.trace_id),
  });
}

/** What a Warp call needs beyond its path. */
interface WarpRequestInit {
  method: 'GET' | 'POST';
  body?: unknown;
  /**
   * `manual` for the transcript endpoint, whose 302 points at a pre-signed
   * download URL we must fetch *without* the Agent key. See
   * {@link getAgentRunTranscript}.
   */
  redirect?: 'follow' | 'manual';
}

/**
 * Call the Warp REST API with the caller's Agent key, returning the raw response.
 *
 * `agentKey` is a parameter rather than resolved here so the only code that ever
 * holds it is the exported function that needed it, and it stays out of every
 * log line and error path in between.
 */
function warpRequest(agentKey: string, path: string, init: WarpRequestInit): Promise<Response> {
  return fetch(`${warpApiBaseUrl()}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${agentKey}`,
      'Content-Type': 'application/json',
    },
    ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/**
 * The JSON body, or null when there isn't one.
 *
 * `POST /agent/runs/{id}/cancel` and `…/followups` answer with a bare string or
 * an empty object, so a hard `response.json()` here would turn a successful
 * mutation into a parse error. Endpoints that genuinely need a payload assert on
 * it themselves.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** {@link warpRequest} plus the non-2xx → {@link WarpApiError} mapping. */
async function warpFetch(
  agentKey: string,
  path: string,
  init: WarpRequestInit,
): Promise<unknown> {
  const response = await warpRequest(agentKey, path, init);

  if (!response.ok) {
    throw await readProblem(response);
  }

  return readJsonBody(response);
}

// ── Run parsing ───────────────────────────────────────────────────────────────

/**
 * Warp's `RunItem`, as far as we read it.
 *
 * `prompt` is present on the wire and deliberately absent here — see
 * {@link WarpAgentRun}.
 */
interface WarpRunBody {
  run_id?: unknown;
  id?: unknown;
  state?: unknown;
  session_link?: unknown;
  title?: unknown;
  agent_config?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  created_at?: unknown;
  updated_at?: unknown;
  started_at?: unknown;
  run_time?: unknown;
  status_message?: unknown;
  source?: unknown;
  execution_location?: unknown;
  session_id?: unknown;
  conversation_id?: unknown;
  parent_run_id?: unknown;
  trigger_url?: unknown;
  is_sandbox_running?: unknown;
  request_usage?: unknown;
  creator?: unknown;
  executor?: unknown;
  agent_skill?: unknown;
  schedule?: unknown;
  artifacts?: unknown;
}

function toStatusMessage(value: unknown): WarpRunStatusMessage | null {
  const body = objectOrNull(value);
  const message = body === null ? undefined : optionalString(body.message);
  if (message === undefined) return null;

  return {
    message,
    errorCode: optionalString(body?.error_code) ?? null,
    retryable: booleanOrNull(body?.retryable),
  };
}

function toUsage(value: unknown): WarpRunUsage | null {
  const body = objectOrNull(value);
  if (body === null) return null;

  return {
    inferenceCost: numberOrNull(body.inference_cost),
    computeCost: numberOrNull(body.compute_cost),
    platformCost: numberOrNull(body.platform_cost),
  };
}

function toPrincipal(value: unknown): WarpRunPrincipal | null {
  const body = objectOrNull(value);
  if (body === null) return null;

  return {
    type: optionalString(body.type) ?? null,
    uid: optionalString(body.uid) ?? null,
    displayName: optionalString(body.display_name) ?? null,
  };
}

function toSkill(value: unknown): WarpRunSkill | null {
  const body = objectOrNull(value);
  if (body === null) return null;

  return {
    name: optionalString(body.name) ?? null,
    fullPath: optionalString(body.full_path) ?? null,
    bundledSkillId: optionalString(body.bundled_skill_id) ?? null,
  };
}

function toSchedule(value: unknown): WarpRunSchedule | null {
  const body = objectOrNull(value);
  if (body === null) return null;

  return {
    scheduleId: optionalString(body.schedule_id) ?? null,
    scheduleName: optionalString(body.schedule_name) ?? null,
    cronSchedule: optionalString(body.cron_schedule) ?? null,
  };
}

/** Artifacts, dropping any entry that is not an object rather than nulling the list. */
function toArtifacts(value: unknown): WarpRunArtifact[] {
  if (!Array.isArray(value)) return [];

  const artifacts: WarpRunArtifact[] = [];
  for (const entry of value) {
    const body = objectOrNull(entry);
    if (body === null) continue;
    artifacts.push({
      artifactType: optionalString(body.artifact_type) ?? null,
      createdAt: optionalString(body.created_at) ?? null,
      data: objectOrNull(body.data),
    });
  }
  return artifacts;
}

/**
 * Normalise a run payload from either endpoint.
 *
 * `POST /agent/run`, `GET /agent/runs/{id}`, and the items of `GET /agent/runs`
 * return overlapping but not identical bodies, and the resolved config has
 * appeared under both `agent_config` and `config`, so both are read rather than
 * pinning one. Every field is optional on the wire, so every one degrades to null
 * instead of failing the read: the only thing worth throwing over is a missing
 * run id, because that is the field that makes the rest addressable.
 */
function toAgentRun(payload: unknown, fallbackRunId?: string): WarpAgentRun {
  const body = (payload ?? {}) as WarpRunBody;
  const runId = optionalString(body.run_id) ?? optionalString(body.id) ?? fallbackRunId;
  if (!runId) {
    throw new WarpApiError('warp_api_error: response carried no run id', { status: 502 });
  }

  const config = body.agent_config ?? body.config ?? null;

  return {
    runId,
    state: optionalString(body.state) ?? null,
    sessionLink: optionalString(body.session_link) ?? null,
    title: optionalString(body.title) ?? null,
    configName: optionalString(config?.name) ?? null,

    createdAt: optionalString(body.created_at) ?? null,
    updatedAt: optionalString(body.updated_at) ?? null,
    startedAt: optionalString(body.started_at) ?? null,
    runTime: optionalString(body.run_time) ?? null,
    statusMessage: toStatusMessage(body.status_message),
    source: optionalString(body.source) ?? null,
    executionLocation: optionalString(body.execution_location) ?? null,
    sessionId: optionalString(body.session_id) ?? null,
    conversationId: optionalString(body.conversation_id) ?? null,
    parentRunId: optionalString(body.parent_run_id) ?? null,
    triggerUrl: optionalString(body.trigger_url) ?? null,
    isSandboxRunning: booleanOrNull(body.is_sandbox_running),
    requestUsage: toUsage(body.request_usage),
    creator: toPrincipal(body.creator),
    executor: toPrincipal(body.executor),
    modelId: optionalString(config?.model_id) ?? null,
    environmentId: optionalString(config?.environment_id) ?? null,
    skillSpec: optionalString(config?.skill_spec) ?? null,
    agentSkill: toSkill(body.agent_skill),
    schedule: toSchedule(body.schedule),
    artifacts: toArtifacts(body.artifacts),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the Warp `config` object for a dispatch.
 *
 * Undefined fields are omitted entirely rather than sent as null, so Warp
 * applies its own defaults (team default model, no environment) instead of
 * receiving an explicit "nothing".
 *
 * `environmentId` arrives already resolved rather than being read here, so this
 * stays a pure projection of its inputs and the precedence rules live in exactly
 * one place ({@link resolveEnvironmentId}).
 */
function buildConfig(
  input: DispatchAgentRunInput,
  jinName: string,
  environmentId: string | undefined,
): WarpAgentConfig & { name: string } {
  const imajinMcp: Record<string, WarpMcpServerConfig> = input.attachImajinMcp
    ? { imajin: { url: getMcpResource() } }
    : {};
  const mcpServers = { ...imajinMcp, ...input.mcpServers };

  return {
    name: input.name ?? jinName,
    ...(input.modelId === undefined ? {} : { model_id: input.modelId }),
    ...(input.basePrompt === undefined ? {} : { base_prompt: input.basePrompt }),
    ...(environmentId === undefined ? {} : { environment_id: environmentId }),
    ...(input.skillSpec === undefined ? {} : { skill_spec: input.skillSpec }),
    ...(Object.keys(mcpServers).length === 0 ? {} : { mcp_servers: mcpServers }),
    ...(input.computerUseEnabled === undefined
      ? {}
      : { computer_use_enabled: input.computerUseEnabled }),
  };
}

/**
 * Dispatch a Warp cloud agent as `principalDid`.
 *
 * Fails closed before any network call when the caller lacks an active
 * `warp:dispatch` grant or has no sealed key — a revoked grant therefore kills
 * dispatch immediately, with no key rotation involved.
 *
 * When the caller names no `environmentId`, their stored default is used, then
 * the node's (#1632).
 *
 * Emits `warp.agent.dispatched` fire-and-forget for the audit trail. The event
 * carries the run's identity and configuration, never the prompt or the key.
 */
export async function dispatchAgentRun(
  principalDid: string,
  input: DispatchAgentRunInput,
): Promise<WarpAgentRun> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new Error('warp_invalid_prompt: prompt must be a non-empty string');
  }

  // Authority gate + unwrap. Everything below holds credential material.
  //
  // The environment and jin-name lookups run after the gate deliberately: both
  // hit the DB, and an unauthorized caller should not be able to make us do that
  // work before being turned away.
  const agentKey = await requireAgentKey(principalDid);
  const [jinName, environmentId] = await Promise.all([
    resolveJinName(principalDid),
    resolveEnvironmentId(principalDid, input.environmentId),
  ]);
  const config = buildConfig(input, jinName, environmentId);

  const payload = await warpFetch(agentKey, '/agent/run', {
    method: 'POST',
    body: {
      prompt,
      ...(input.title === undefined ? {} : { title: input.title }),
      config,
    },
  });

  const run = toAgentRun(payload);

  log.info(
    {
      principalDid,
      runId: run.runId,
      state: run.state,
      configName: config.name,
      skillSpec: config.skill_spec,
      environmentId: config.environment_id,
    },
    'Warp cloud agent dispatched',
  );

  publish('warp.agent.dispatched', {
    issuer: principalDid,
    subject: principalDid,
    scope: 'warp',
    payload: {
      runId: run.runId,
      principalDid,
      configName: config.name,
      state: run.state,
      skillSpec: config.skill_spec ?? null,
      environmentId: config.environment_id ?? null,
      context_id: run.runId,
      context_type: 'warp.agent',
    },
  }).catch((err: unknown) => {
    log.error(
      { err: String(err), runId: run.runId },
      'Bus publish error for warp.agent.dispatched',
    );
  });

  return run;
}

/**
 * Read a run's full detail as `principalDid`.
 *
 * Gated by the same grant as dispatch, and read with the same key — so a caller
 * can only ever see runs their own credential created.
 *
 * Parses everything the response carries except the prompt (#1639): lifecycle
 * timestamps, `run_time`, `status_message`, cost, provenance, and the run's
 * artifacts. That is zero extra network cost — the fields were always in this
 * body — and it is what makes a failed run diagnosable and a finished one
 * measurable.
 */
export async function getAgentRun(principalDid: string, runId: string): Promise<WarpAgentRun> {
  const id = requireRunId(runId);

  const agentKey = await requireAgentKey(principalDid);
  const payload = await warpFetch(agentKey, runPath(id), { method: 'GET' });

  return toAgentRun(payload, id);
}

/**
 * List the runs the caller's own key can see (#1639).
 *
 * `state` is repeated rather than comma-joined — Warp declares it as an exploded
 * form array, so `?state=QUEUED&state=INPROGRESS` is the only shape it reads.
 */
function buildRunsQuery(input: ListAgentRunsInput): string {
  const params = new URLSearchParams();

  const name = optionalString(input.name?.trim());
  if (name !== undefined) params.set('name', name);

  for (const state of input.states ?? []) {
    const value = optionalString(state.trim());
    if (value !== undefined) params.append('state', value);
  }

  const environmentId = optionalString(input.environmentId?.trim());
  if (environmentId !== undefined) params.set('environment_id', environmentId);

  const createdAfter = optionalString(input.createdAfter?.trim());
  if (createdAfter !== undefined) params.set('created_after', createdAfter);

  const cursor = optionalString(input.cursor?.trim());
  if (cursor !== undefined) params.set('cursor', cursor);

  // Clamped rather than rejected: an out-of-range page size is a caller
  // misunderstanding, not a reason to fail a read they are entitled to.
  if (input.limit !== undefined && Number.isFinite(input.limit)) {
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit)));
    params.set('limit', String(limit));
  }

  const query = params.toString();
  return query.length === 0 ? '' : `?${query}`;
}

/**
 * List runs as `principalDid`, newest-updated first.
 *
 * Same key, so the listing is naturally scoped to what that credential created —
 * the `name` filter then narrows it to a single `{username}-jin` tag, which is
 * how run history and cost tracking per jin are read.
 *
 * A run item that carries no id is skipped rather than failing the page: one
 * malformed entry should not cost the caller the other nineteen.
 */
export async function listAgentRuns(
  principalDid: string,
  input: ListAgentRunsInput = {},
): Promise<WarpAgentRunPage> {
  const agentKey = await requireAgentKey(principalDid);
  const payload = await warpFetch(agentKey, `/agent/runs${buildRunsQuery(input)}`, {
    method: 'GET',
  });

  const body = objectOrNull(payload);
  if (body === null) {
    throw new WarpApiError('warp_api_error: run list response was not an object', { status: 502 });
  }

  const runs: WarpAgentRun[] = [];
  for (const entry of Array.isArray(body.runs) ? body.runs : []) {
    try {
      runs.push(toAgentRun(entry));
    } catch {
      continue;
    }
  }

  const pageInfo = objectOrNull(body.page_info);

  return {
    runs,
    hasNextPage: booleanOrNull(pageInfo?.has_next_page) ?? false,
    nextCursor: optionalString(pageInfo?.next_cursor) ?? null,
  };
}

/**
 * Cap on the transcript text handed back, in characters.
 *
 * A transcript is unbounded upstream and ends up inside a JSON response body, so
 * it is truncated with a flag rather than streamed: a caller diagnosing a failure
 * reads the head of it, and an un-capped read is a memory hazard on the kernel
 * for no benefit.
 */
export const TRANSCRIPT_MAX_CHARS = 2_000_000;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Resolve the transcript body, following Warp's 302 by hand.
 *
 * The redirect is followed manually and the download is fetched with **no**
 * Authorization header. Warp's `Location` is a pre-signed, time-limited URL on
 * storage infrastructure that is not Warp's API host, and letting `fetch` follow
 * it automatically risks presenting the caller's sealed Agent key to whatever
 * host that is. The signature is the credential there; ours has no business
 * being sent.
 */
async function readTranscript(response: Response): Promise<{ text: string; contentType: string | null }> {
  if (isRedirect(response.status)) {
    const location = response.headers.get('location') ?? '';
    if (location.length === 0) {
      throw new WarpApiError('warp_api_error: transcript redirect carried no Location', {
        status: 502,
      });
    }

    const download = await fetch(location);
    if (!download.ok) {
      throw new WarpApiError(`warp_api_error: ${download.status} transcript download failed`, {
        status: download.status,
      });
    }

    return { text: await download.text(), contentType: download.headers.get('content-type') };
  }

  if (!response.ok) {
    throw await readProblem(response);
  }

  // Warp documents a 302, but a 200 with the transcript inline is answered the
  // same way rather than treated as a protocol error.
  return { text: await response.text(), contentType: response.headers.get('content-type') };
}

/**
 * Read a run's raw transcript as `principalDid` (#1639).
 *
 * This is the self-diagnosis path: when a dispatched run fails, the transcript is
 * the only place that says why, and it was previously unreachable because the
 * download is auth-gated.
 */
export async function getAgentRunTranscript(
  principalDid: string,
  runId: string,
  options: { maxChars?: number } = {},
): Promise<WarpAgentRunTranscript> {
  const id = requireRunId(runId);
  const maxChars =
    options.maxChars !== undefined && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.trunc(options.maxChars)
      : TRANSCRIPT_MAX_CHARS;

  const agentKey = await requireAgentKey(principalDid);
  const response = await warpRequest(agentKey, runPath(id, '/transcript'), {
    method: 'GET',
    redirect: 'manual',
  });

  const { text, contentType } = await readTranscript(response);
  const truncated = text.length > maxChars;

  return {
    runId: id,
    content: truncated ? text.slice(0, maxChars) : text,
    contentType,
    truncated,
  };
}

/**
 * Read a run's normalized conversation as `principalDid` (#1639).
 *
 * The step tree is passed through as Warp returns it. Warp owns that union and
 * extends it (new action categories, new event names), so re-modelling it here
 * would drift silently — the same call the dispatch route makes for
 * `mcp_servers`.
 */
export async function getAgentRunConversation(
  principalDid: string,
  runId: string,
): Promise<WarpAgentRunConversation> {
  const id = requireRunId(runId);

  const agentKey = await requireAgentKey(principalDid);
  const payload = await warpFetch(agentKey, runPath(id, '/conversation'), { method: 'GET' });

  const body = objectOrNull(payload);
  if (body === null) {
    throw new WarpApiError('warp_api_error: conversation response was not an object', {
      status: 502,
    });
  }

  return {
    runId: id,
    conversationId: optionalString(body.conversation_id) ?? null,
    steps: Array.isArray(body.steps) ? (body.steps as WarpConversationStep[]) : [],
  };
}

/**
 * Cancel a queued or in-progress run as `principalDid` (#1639).
 *
 * Warp answers 200 with the cancelled run id, and rejects the cases it cannot
 * serve with specific statuses — 400 for an already-terminal run, 409 while it is
 * still PENDING (retryable), 422 for run types that cannot be cancelled at all.
 * Those are surfaced as-is through {@link WarpApiError} rather than being
 * flattened, because "retry in a moment" and "never going to work" are different
 * answers for the caller.
 */
export async function cancelAgentRun(
  principalDid: string,
  runId: string,
): Promise<WarpAgentRunCancellation> {
  const id = requireRunId(runId);

  const agentKey = await requireAgentKey(principalDid);
  await warpFetch(agentKey, runPath(id, '/cancel'), { method: 'POST' });

  log.info({ principalDid, runId: id }, 'Warp cloud agent run cancelled');

  return { runId: id, cancelled: true };
}

const FOLLOWUP_MODES: readonly WarpFollowupMode[] = ['normal', 'plan', 'orchestrate'];

/**
 * Send a follow-up message to an existing run as `principalDid` (#1639).
 *
 * Mid-run course correction: Warp routes the message according to whatever the
 * run is currently doing, so a 200 means "accepted", not "applied" — the effect is
 * observed through {@link getAgentRun}.
 *
 * An unknown `mode` is rejected here rather than forwarded: the set is small and
 * closed, and a typo silently downgrading a `plan` follow-up to `normal` is worse
 * than a 400.
 */
export async function sendFollowup(
  principalDid: string,
  runId: string,
  input: SendFollowupInput,
): Promise<WarpFollowupAck> {
  const id = requireRunId(runId);

  const message = input.message.trim();
  if (message.length === 0) {
    throw new Error('warp_invalid_message: message must be a non-empty string');
  }

  if (input.mode !== undefined && !FOLLOWUP_MODES.includes(input.mode)) {
    throw new Error(`warp_invalid_mode: mode must be one of ${FOLLOWUP_MODES.join(', ')}`);
  }

  const agentKey = await requireAgentKey(principalDid);
  await warpFetch(agentKey, runPath(id, '/followups'), {
    method: 'POST',
    body: {
      message,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    },
  });

  log.info({ principalDid, runId: id, mode: input.mode ?? null }, 'Warp run follow-up accepted');

  return { runId: id, accepted: true };
}

// ── Completion watch (#1639) ──────────────────────────────────────────────────

/** A terminal state, i.e. one nothing further will happen from. */
export type WarpRunTerminalState = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/**
 * Terminal run states.
 *
 * `BLOCKED` is deliberately absent: a blocked run is waiting on a human, not
 * finished, and a watch that treated it as an ending would report a completion
 * for work that is still going to happen.
 */
const TERMINAL_STATES = new Set<string>(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * Gaps between polls, in ms, applied in order and then held at the last value.
 *
 * Increasing rather than fixed because run durations are bimodal: most finish in
 * the first minute, and the ones that do not run for many minutes. A flat 5s
 * would cost ~360 reads on a 30-minute run for no extra information.
 */
export const WATCH_POLL_INTERVALS_MS: readonly number[] = [5_000, 10_000, 30_000, 60_000];

/** How long a watch waits for a terminal state before giving up. */
export const WATCH_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * Consecutive failed reads after which a watch stops.
 *
 * A read can fail transiently (a 502, a dropped connection) and retrying is
 * right. It can also fail permanently in ways that are not classifiable up front,
 * and a watch that retried those for the full 30 minutes would just be noise.
 */
const WATCH_MAX_CONSECUTIVE_ERRORS = 5;

/** State reported when a watch never managed to read the run even once. */
const UNKNOWN_STATE = 'UNKNOWN';

/** Stand-in for an artifact Warp returned without an `artifact_type`. */
const UNKNOWN_ARTIFACT_TYPE = 'UNKNOWN';

export interface WatchRunOptions {
  /** Override the poll schedule. Tests pass short gaps; production uses the default. */
  intervalsMs?: readonly number[];
  /** Override the total budget. Defaults to {@link WATCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable delay, so a test does not have to wait real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait `ms`, without holding the process open.
 *
 * The timer is unref'd: a watch may have a 60-second sleep in flight when a
 * deploy restarts the kernel, and a pending completion event is not worth
 * delaying a shutdown for.
 */
function sleepFor(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    timer.unref?.();
  });
}

/**
 * Whether retrying this error is pointless.
 *
 * A revoked grant, a purged key, or a run this credential cannot see will answer
 * the same way for the rest of the watch, so the budget is better abandoned than
 * spent. Everything else is treated as transient and retried.
 */
function isUnrecoverableWatchError(err: unknown): boolean {
  if (err instanceof WarpApiError) {
    return err.status === 401 || err.status === 403 || err.status === 404;
  }

  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith('warp_no_grant') || message.startsWith('warp_no_secret');
}

/**
 * Flatten a run's artifacts to the fields a bus listener acts on.
 *
 * `data` is Warp's own per-type object; `url` and `branch` are lifted out of it
 * because for a `PULL_REQUEST` artifact they are the PR linkage this issue exists
 * to stop people searching GitHub for. The rest of `data` is dropped rather than
 * passed through: it is unbounded, and events are persisted.
 */
function toEventArtifacts(
  artifacts: WarpRunArtifact[],
): Array<{ type: string; url: string | null; branch: string | null }> {
  return artifacts.map((artifact) => ({
    type: artifact.artifactType ?? UNKNOWN_ARTIFACT_TYPE,
    url: optionalString(artifact.data?.url) ?? null,
    branch: optionalString(artifact.data?.branch) ?? null,
  }));
}

/** How a watch ended. */
type WatchOutcome =
  | { kind: 'terminal'; run: WarpAgentRun; state: WarpRunTerminalState }
  | { kind: 'timeout'; lastKnownState: string }
  /** Reads kept failing, or failed in a way retrying cannot fix. */
  | { kind: 'abandoned'; lastKnownState: string };

/**
 * Poll `runId` until it is terminal, the budget runs out, or reads stop working.
 *
 * The final sleep is truncated to the remaining budget, so the deadline gets one
 * last read landing exactly on it rather than being overshot by up to a minute.
 */
async function pollUntilTerminal(
  principalDid: string,
  runId: string,
  options: WatchRunOptions,
): Promise<WatchOutcome> {
  const intervals =
    options.intervalsMs !== undefined && options.intervalsMs.length > 0
      ? options.intervalsMs
      : WATCH_POLL_INTERVALS_MS;
  const timeoutMs = options.timeoutMs ?? WATCH_TIMEOUT_MS;
  const sleep = options.sleep ?? sleepFor;

  const deadline = Date.now() + timeoutMs;
  let lastKnownState = UNKNOWN_STATE;
  let consecutiveErrors = 0;

  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: 'timeout', lastKnownState };

    await sleep(Math.min(intervals[Math.min(attempt, intervals.length - 1)], remaining));

    let run: WarpAgentRun;
    try {
      run = await getAgentRun(principalDid, runId);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      const fatal = isUnrecoverableWatchError(err);
      log.warn(
        { err: String(err), principalDid, runId, consecutiveErrors, fatal },
        'Warp run watch could not read the run',
      );
      if (fatal || consecutiveErrors >= WATCH_MAX_CONSECUTIVE_ERRORS) {
        return { kind: 'abandoned', lastKnownState };
      }
      continue;
    }

    lastKnownState = run.state ?? lastKnownState;
    if (run.state !== null && TERMINAL_STATES.has(run.state)) {
      return { kind: 'terminal', run, state: run.state as WarpRunTerminalState };
    }
  }
}

async function publishRunCompleted(
  principalDid: string,
  run: WarpAgentRun,
  state: WarpRunTerminalState,
): Promise<void> {
  await publish('warp.run.completed', {
    issuer: principalDid,
    subject: principalDid,
    scope: 'warp',
    payload: {
      runId: run.runId,
      state,
      title: run.title,
      configName: run.configName,
      runTime: run.runTime,
      statusMessage: run.statusMessage,
      requestUsage: run.requestUsage,
      artifacts: toEventArtifacts(run.artifacts),
      sessionLink: run.sessionLink,
      principalDid,
      completedAt: new Date().toISOString(),
      // Same context as `warp.agent.dispatched`, so dispatch and completion are
      // one thread rather than two unrelated rows.
      context_id: run.runId,
      context_type: 'warp.agent',
    },
  });
}

async function publishRunTimeout(
  principalDid: string,
  runId: string,
  lastKnownState: string,
): Promise<void> {
  await publish('warp.run.timeout', {
    issuer: principalDid,
    subject: principalDid,
    scope: 'warp',
    payload: {
      runId,
      lastKnownState,
      principalDid,
      timedOutAt: new Date().toISOString(),
      context_id: runId,
      context_type: 'warp.agent',
    },
  });
}

/**
 * Watch a dispatched run to its end and put the outcome on the bus (#1639).
 *
 * Publishes `warp.run.completed` on a terminal state and `warp.run.timeout` when
 * the budget runs out, so an orchestrating agent never has to poll `getAgentRun`
 * by hand — which was the whole manual step this stage removes.
 *
 * Reads with the caller's own sealed key, through {@link getAgentRun}, so a watch
 * has exactly the authority the dispatch had and dies with the grant.
 *
 * **Never rejects and never throws.** This is started fire-and-forget from the
 * dispatch route, where an unhandled rejection would be a process-level event for
 * something as inconsequential as a failed status read. Every failure is logged
 * and swallowed instead.
 *
 * Returns a promise that resolves when the watch is done, so callers that *do*
 * care (tests, a future synchronous "dispatch and wait") can await it.
 */
export async function watchRun(
  principalDid: string,
  runId: string,
  options: WatchRunOptions = {},
): Promise<void> {
  try {
    const id = requireRunId(runId);
    const outcome = await pollUntilTerminal(principalDid, id, options);

    if (outcome.kind === 'terminal') {
      log.info(
        {
          principalDid,
          runId: id,
          state: outcome.state,
          runTime: outcome.run.runTime,
          errorCode: outcome.run.statusMessage?.errorCode ?? null,
        },
        'Warp cloud agent run reached a terminal state',
      );
      await publishRunCompleted(principalDid, outcome.run, outcome.state);
      return;
    }

    if (outcome.kind === 'timeout') {
      log.warn(
        { principalDid, runId: id, lastKnownState: outcome.lastKnownState },
        'Warp run watch timed out before the run reached a terminal state',
      );
      await publishRunTimeout(principalDid, id, outcome.lastKnownState);
      return;
    }

    // Abandoned: the run may still be running, but nothing is going to report on
    // it. No event, because we know nothing about the outcome — only that we can
    // no longer see it, which the warn above already records.
    log.warn(
      { principalDid, runId: id, lastKnownState: outcome.lastKnownState },
      'Warp run watch abandoned; the run is no longer readable',
    );
  } catch (err) {
    log.error({ err: String(err), principalDid, runId }, 'Warp run watch failed');
  }
}
