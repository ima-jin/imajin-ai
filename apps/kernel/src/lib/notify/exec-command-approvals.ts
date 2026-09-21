/**
 * `exec.command` approval kind (#2221) — kernel half of the exec-approval
 * gate for forwarded OpenClaw host-exec approvals. Parent epic #2084;
 * builds directly on the generic operator-approvals rail (#2152/#2154).
 * Plugin/consumer half: `ima-jin/openclaw-imajin-plugin#38` (the
 * `gateway-exec` ApprovalSource) — a separate repo/process; this module
 * defines what it implements against, never imports it.
 *
 * ## Wire contract
 *
 * `source: 'gateway-exec'`, `kind: 'gateway-exec:command'`. Note this
 * deviates from the issue's shorthand `exec.command` — the kernel's open
 * vocabulary (#2152, `normalizeSourceAndKind` in `./operator-approvals`)
 * requires `kind` to be namespaced `"<source>:<subkind>"` with a
 * lowercase-hyphenated subkind (no dots), the same convention every other
 * source (`system-agent:restart`, `skill-workshop:update`) already uses.
 * `gateway-exec:command` is the exact, disclosed adaptation the plugin
 * side must publish — see the PR body for #2221.
 *
 * `detail` (hashed via the generic `contentHash`, covering the whole
 * canonical payload including `detail` — never summarised, never
 * truncated: a `detail` that doesn't fit the generic 16KB cap is rejected
 * outright, not shrunk, so what the operator signs is always the exact
 * verbatim command):
 *   - `command` — the exact full command string as OpenClaw will execute
 *     it (chains/multiline included). Deliberately NOT run through
 *     secret-value scanning the way `summary`/`keysTouched` are — the
 *     whole point of this card is showing the verbatim command;
 *     redacting it would defeat the gate. The plugin is responsible for
 *     never resolving a `SecretRef` into a command before staging the
 *     approval, same posture as the generic contract's
 *     `summary`/`keysTouched` boundary.
 *   - `host` — gateway|node id|sandbox identifier.
 *   - `cwd` — working directory the command runs in.
 *   - `agentId` — the requesting agent's id.
 *   - `sessionKey` — the requesting agent's session key.
 *   - `requestedBy` — the requesting agent's DID (`did:...`).
 *   - `approvalId` — the OpenClaw-side approval id (distinct from the
 *     kernel's own `proposalId`).
 *   - `expiresAt` — ISO 8601 timestamp; a decision after this instant is
 *     refused (see {@link isExecCommandExpired}).
 *
 * ## Decision vocabulary: allow-once | deny only
 *
 * The kernel's generic decision vocabulary is `approve | reject |
 * withdrawn` (#2152) with an optional, normally-uninterpreted `mode`
 * string a caller may attach (e.g. system-agent maps `approve` ->
 * `allow-once` client-side, entirely outside the kernel's own
 * validation). For `exec.command`, standing trust (`allow-always`) is
 * exactly what this gate exists to prevent (Ryan, 2026-09-20) — so unlike
 * every other kind, the kernel itself enforces the mode here: `approve`
 * only ever pairs with `mode` absent or `'allow-once'`, `reject` only
 * with `mode` absent or `'deny'`. Any other value — most importantly
 * `'allow-always'` — is rejected with 400 by
 * {@link validateExecCommandDecisionMode}, called from
 * `decideOperatorApproval` before any state mutation. This closes the
 * loophole where a caller could hit the generic decide API directly with
 * an arbitrary `mode` even though the /jin card only ever renders two
 * buttons.
 */

/** The open-vocabulary source this kind is filed under (#2152). */
export const EXEC_COMMAND_SOURCE = 'gateway-exec';

/** The namespaced kind — see the wire-contract note above for why this isn't literally `exec.command`. */
export const EXEC_COMMAND_KIND = 'gateway-exec:command';

/** The only two decisions ever legal for this kind (`withdrawn` is the generic pre-apply revoke and is left alone). */
type ExecCommandGatedDecision = 'approve' | 'reject';

export interface ExecCommandDetail {
  command: string;
  host: string;
  cwd: string;
  agentId: string;
  sessionKey: string;
  requestedBy: string;
  approvalId: string;
  expiresAt: string;
}

export type ExecCommandDetailValidationResult =
  | { ok: true; detail: ExecCommandDetail }
  | { ok: false; error: string };

/** Every `ExecCommandDetail` field, in the order acceptance requires validating them. */
const REQUIRED_STRING_FIELDS = ['command', 'host', 'cwd', 'agentId', 'sessionKey', 'requestedBy', 'approvalId', 'expiresAt'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates the exec.command `detail` schema (#2221 scope item 1): every
 * field listed in the issue, present and non-empty, `requestedBy` shaped
 * like a DID, and `expiresAt` a parseable timestamp. Rejects (never
 * coerces/defaults) so a malformed request gets an actionable 400 instead
 * of a card missing a field the operator needs to make an informed
 * decision.
 */
export function validateExecCommandDetail(detail: Record<string, unknown> | null): ExecCommandDetailValidationResult {
  if (!detail) {
    return { ok: false, error: 'detail is required for gateway-exec:command approvals' };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(detail[field])) {
      return { ok: false, error: `detail.${field} is required and must be a non-empty string` };
    }
  }

  const requestedBy = detail.requestedBy as string;
  if (!requestedBy.startsWith('did:')) {
    return { ok: false, error: 'detail.requestedBy must be a DID (did:...)' };
  }

  const expiresAt = detail.expiresAt as string;
  if (Number.isNaN(Date.parse(expiresAt))) {
    return { ok: false, error: 'detail.expiresAt must be a valid ISO 8601 timestamp' };
  }

  return {
    ok: true,
    detail: {
      command: detail.command as string,
      host: detail.host as string,
      cwd: detail.cwd as string,
      agentId: detail.agentId as string,
      sessionKey: detail.sessionKey as string,
      requestedBy,
      approvalId: detail.approvalId as string,
      expiresAt,
    },
  };
}

/** Best-effort cast of a stored row's `detail` back to `ExecCommandDetail` — `null` when it doesn't (or no longer) validate. */
export function asExecCommandDetail(detail: Record<string, unknown> | null): ExecCommandDetail | null {
  const result = validateExecCommandDetail(detail);
  return result.ok ? result.detail : null;
}

/** True once `detail.expiresAt` is at or before `now` (defaults to the real current time). */
export function isExecCommandExpired(detail: Pick<ExecCommandDetail, 'expiresAt'>, now: Date = new Date()): boolean {
  const expiresAtMs = Date.parse(detail.expiresAt);
  return !Number.isNaN(expiresAtMs) && expiresAtMs <= now.getTime();
}

/**
 * Post-exec outcome follow-up (#2221 scope item 4) — the bridge posts this
 * back once the OpenClaw gateway finishes running an allow-once'd command,
 * attached to the approval record so the card shows wish -> grant -> what
 * actually ran. `outputHash` is a digest over the (bridge-side, truncated)
 * stdout/stderr — the kernel never sees or stores raw command output.
 */
export interface ExecCommandOutcome {
  exitCode: number;
  durationMs: number;
  outputHash: string;
}

export type ExecCommandModeValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Enforces "allow-once | deny only" (#2221 acceptance: "allow-always must
 * be unreachable... at the card AND the API"). `withdrawn` is left alone
 * (the generic pre-apply revoke, orthogonal to this gate). `mode` absent
 * is always fine — the source adapter maps `approve`/`reject` onto its
 * own vocabulary (e.g. OpenClaw's `allow-once`/`deny`) without the kernel
 * needing an explicit `mode` at all; this only rejects a `mode` that was
 * actually supplied and disagrees with the one legal value for that
 * decision (most importantly, `'allow-always'` is never a legal value
 * here regardless of which decision it's paired with).
 */
export function validateExecCommandDecisionMode(
  decision: ExecCommandGatedDecision | 'withdrawn',
  mode: string | undefined,
): ExecCommandModeValidationResult {
  if (decision === 'withdrawn' || mode === undefined) return { ok: true };

  const allowed = decision === 'approve' ? 'allow-once' : 'deny';
  if (mode === allowed) return { ok: true };

  return {
    ok: false,
    error: `mode must be '${allowed}' for a ${decision} decision on exec.command approvals (got '${mode}') — allow-always is never permitted for this kind`,
  };
}
