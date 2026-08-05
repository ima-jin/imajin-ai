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

/** What a caller learns about a run. Never includes credential material. */
export interface WarpAgentRun {
  runId: string;
  state: string | null;
  sessionLink: string | null;
  title: string | null;
  configName: string | null;
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

/**
 * Call the Warp REST API with the caller's Agent key.
 *
 * `agentKey` is a parameter rather than resolved here so the only code that ever
 * holds it is the exported function that needed it, and it stays out of every
 * log line and error path in between.
 */
async function warpFetch(
  agentKey: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<unknown> {
  const response = await fetch(`${warpApiBaseUrl()}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${agentKey}`,
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    throw await readProblem(response);
  }

  return response.json();
}

// ── Run parsing ───────────────────────────────────────────────────────────────

interface WarpRunBody {
  run_id?: unknown;
  id?: unknown;
  state?: unknown;
  session_link?: unknown;
  title?: unknown;
  agent_config?: { name?: unknown } | null;
  config?: { name?: unknown } | null;
}

/**
 * Normalise a run payload from either endpoint.
 *
 * `POST /agent/run` and `GET /agent/runs/{id}` return overlapping but not
 * identical bodies, and the resolved config has appeared under both
 * `agent_config` and `config`, so both are read rather than pinning one.
 */
function toAgentRun(payload: unknown, fallbackRunId?: string): WarpAgentRun {
  const body = (payload ?? {}) as WarpRunBody;
  const runId = optionalString(body.run_id) ?? optionalString(body.id) ?? fallbackRunId;
  if (!runId) {
    throw new WarpApiError('warp_api_error: response carried no run id', { status: 502 });
  }

  return {
    runId,
    state: optionalString(body.state) ?? null,
    sessionLink: optionalString(body.session_link) ?? null,
    title: optionalString(body.title) ?? null,
    configName: optionalString(body.agent_config?.name) ?? optionalString(body.config?.name) ?? null,
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
 * Read a run's lifecycle state and `session_link` as `principalDid`.
 *
 * Gated by the same grant as dispatch, and read with the same key — so a caller
 * can only ever see runs their own credential created.
 */
export async function getAgentRun(principalDid: string, runId: string): Promise<WarpAgentRun> {
  const trimmedRunId = runId.trim();
  if (trimmedRunId.length === 0) {
    throw new Error('warp_invalid_run_id: runId must be a non-empty string');
  }

  const agentKey = await requireAgentKey(principalDid);
  const payload = await warpFetch(agentKey, `/agent/runs/${encodeURIComponent(trimmedRunId)}`, {
    method: 'GET',
  });

  return toAgentRun(payload, trimmedRunId);
}
