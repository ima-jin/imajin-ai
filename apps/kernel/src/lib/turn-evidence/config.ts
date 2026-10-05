/**
 * Config for `agent.turn.evidence` (#1978).
 *
 * "Hash by default, retain by exception": every tool call commits an
 * `inputHash`/`outputHash`, but the raw output may be retained as a
 * principal-owned media asset (`outputRef`) only when the tool is flagged
 * *evidentiary* — chain reads, HTTP fetches used to support a factual claim.
 * The allowlist lives in config (env), not in the signed payload: a
 * publisher cannot self-declare a tool evidentiary.
 */

/** Env var: comma-separated tool names whose raw output may be retained. */
export const EVIDENTIARY_TOOLS_ENV = 'TURN_EVIDENCE_EVIDENTIARY_TOOLS';

/** Used when the env var is unset. Deliberately narrow — extend via env, not code. */
export const DEFAULT_EVIDENTIARY_TOOLS: readonly string[] = ['web_fetch', 'chain_read'];

/** Resolve the evidentiary-tool allowlist. An explicitly empty value disables retention entirely. */
export function getEvidentiaryTools(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  const raw = env[EVIDENTIARY_TOOLS_ENV];
  if (raw === undefined) return new Set(DEFAULT_EVIDENTIARY_TOOLS);
  return new Set(
    raw
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

export function isEvidentiaryTool(toolName: string, env: Record<string, string | undefined> = process.env): boolean {
  return getEvidentiaryTools(env).has(toolName);
}

/** Per-IP request budget for the unauthenticated verify endpoint (requests per window). */
export const VERIFY_RATE_LIMIT = 30;
export const VERIFY_RATE_WINDOW_MS = 60_000;

/** Per-agent request budget for batch ingest (batches per window). */
export const INGEST_RATE_LIMIT = 60;
export const INGEST_RATE_WINDOW_MS = 60_000;
