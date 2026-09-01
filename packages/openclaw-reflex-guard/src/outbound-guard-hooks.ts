/**
 * Layer 1 hook adapters. Boundary choice (see PR "Decisions for review"):
 * `before_agent_finalize` can only ask the harness for `{ action: "revise" }`
 * (one more model pass) or `{ action: "finalize" }` — it cannot cancel or
 * rewrite outbound content (confirmed against `docs/plugins/hooks.md` and
 * `src/plugins/hook-types.ts` in openclaw/openclaw). `message_sending` and
 * `before_dispatch` are "Messages and delivery" hooks that CAN cancel or
 * rewrite outbound content, so the hard block/flag guard lives there.
 */
import type { ResolvedOutboundGuardConfig } from "./guard-config.js";
import { scanOutboundContent } from "./guard-matcher.js";
import type { AuditLogger } from "./audit-log.js";

const BLOCK_REASON = "reflex-guard: sealed term matched (see audit log for term id)";
const GUARD_ERROR_REASON = "reflex-guard: guard error — failing closed";
const DISPATCH_BLOCKED_REPLY = "Your message could not be sent.";

/**
 * `message_sending` hook event/result — confirmed contract
 * (`src/plugins/hook-message.types.ts` in openclaw/openclaw):
 * `{ to, content, replyToId?, threadId?, metadata? }` in,
 * `{ content?, cancel?, cancelReason?, metadata? }` out.
 */
export interface MessageSendingEvent {
  to: string;
  content: string;
  replyToId?: string | number;
  threadId?: string | number;
  metadata?: Record<string, unknown>;
}

export interface MessageSendingResult {
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
  metadata?: Record<string, unknown>;
}

/** `ctx` passed alongside a `message_sending`/`message_sent` event (`PluginHookMessageContext`). */
export interface MessageHookContext {
  sessionKey?: string;
  [key: string]: unknown;
}

/**
 * Builds the `message_sending` handler: the hard block/cancel seam for
 * Layer 1. This is the only seam in the hook catalog that can
 * unconditionally cancel an outbound message before it reaches a channel.
 *
 * Fails CLOSED on its own errors (cancels delivery) rather than the more
 * common fail-open convention elsewhere in this codebase: for a
 * patent-disclosure-class secret, a false block is a cheap annoyance while a
 * false pass is the exact failure this plugin exists to prevent (mirrors the
 * issue's own asymmetry rule for the Layer 2 warrant gate).
 */
export function createMessageSendingHandler(
  resolved: ResolvedOutboundGuardConfig,
  auditLogger: AuditLogger,
): (event: MessageSendingEvent, ctx?: MessageHookContext) => MessageSendingResult | undefined {
  return (event, ctx) => {
    if (!resolved.enabled || resolved.terms.length === 0) return undefined;
    try {
      const content = typeof event?.content === "string" ? event.content : "";
      if (!content) return undefined;
      const { matches, action } = scanOutboundContent(content, resolved.terms);
      for (const match of matches) {
        auditLogger.record({
          termId: match.termId,
          surface: "message_sending",
          action: match.action,
          sessionKey: ctx?.sessionKey,
        });
      }
      if (action === "block") {
        return { cancel: true, cancelReason: BLOCK_REASON };
      }
      // "flag" or "none" — let the content through unchanged. Flag-only
      // trips are still audit-logged above; they just don't hold delivery.
      return undefined;
    } catch (err) {
      console.error(
        "[reflex-guard] message_sending handler error — failing closed:",
        err instanceof Error ? err.message : String(err),
      );
      return { cancel: true, cancelReason: GUARD_ERROR_REASON };
    }
  };
}

/**
 * `before_dispatch` hook event/result. Confirmed contract as of the hook's
 * introduction (openclaw/openclaw#43422): `{ block?: boolean; replyText?: string }`.
 * The result shape for this hook has shifted across OpenClaw releases in the
 * wild (a later refactor uses `{ handled, text }` on at least one fork
 * lineage) — VERIFY against the installed runtime's
 * `openclaw plugins inspect reflex-guard --runtime --json` before enabling
 * this seam in production. See the PR's "Decisions for review".
 */
export interface BeforeDispatchEvent {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  isGroup?: boolean;
  timestamp?: number;
}

export interface BeforeDispatchResult {
  block?: boolean;
  replyText?: string;
}

/**
 * Builds the `before_dispatch` handler: a second Layer 1 seam covering
 * dispatch-path outbound content that may not route through
 * `message_sending` on every channel adapter.
 */
export function createBeforeDispatchHandler(
  resolved: ResolvedOutboundGuardConfig,
  auditLogger: AuditLogger,
): (event: BeforeDispatchEvent) => BeforeDispatchResult | undefined {
  return (event) => {
    if (!resolved.enabled || resolved.terms.length === 0) return undefined;
    try {
      const content = (typeof event?.content === "string" && event.content) || event?.body || "";
      if (!content) return undefined;
      const { matches, action } = scanOutboundContent(content, resolved.terms);
      for (const match of matches) {
        auditLogger.record({
          termId: match.termId,
          surface: "before_dispatch",
          action: match.action,
          sessionKey: event?.sessionKey,
        });
      }
      if (action === "block") {
        return { block: true, replyText: DISPATCH_BLOCKED_REPLY };
      }
      return undefined;
    } catch (err) {
      console.error(
        "[reflex-guard] before_dispatch handler error — failing closed:",
        err instanceof Error ? err.message : String(err),
      );
      return { block: true, replyText: DISPATCH_BLOCKED_REPLY };
    }
  };
}
