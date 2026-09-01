/**
 * Reflex Guard — post-turn instruction-check hook (imajin-ai#1252)
 *
 * Layer 1 (ship-ready): deterministic outbound sealed-term guard on
 * `message_sending` + `before_dispatch`. Config-driven, no LLM call, no
 * sealed/sensitive terms hardcoded — see `config/sealed-terms.example.json`.
 *
 * Layer 2 (scaffold, default OFF): warrant-gate -> injection-check ->
 * own-and-stamp flow wired to `before_agent_finalize`, with the LLM-judgment
 * step stubbed pending real training data (see `src/reflex-injection-check.ts`).
 *
 * Config (openclaw.json):
 *   "reflex-guard": {
 *     "enabled": true,
 *     "config": {
 *       "guard": {
 *         "terms": [ { "id": "...", "pattern": "...", "action": "block" } ],
 *         "auditLogPath": "reflex-guard/audit-log.jsonl"
 *       },
 *       "reflex": { "enabled": false }
 *     }
 *   }
 */

import { definePluginEntry, type PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveOutboundGuardConfig, type OutboundGuardConfig } from "./src/guard-config.js";
import { createAuditLogger } from "./src/audit-log.js";
import { createMessageSendingHandler, createBeforeDispatchHandler } from "./src/outbound-guard-hooks.js";
import { createReflexFinalizeHandler, type ReflexConfig } from "./src/reflex-finalize-hook.js";

interface ReflexGuardPluginConfig {
  guard?: OutboundGuardConfig;
  reflex?: ReflexConfig;
}

export default definePluginEntry({
  id: "reflex-guard",
  name: "Reflex Guard",
  description:
    "Post-turn instruction-check guard (imajin-ai#1252): a deterministic " +
    "outbound sealed-term guard on message_sending/before_dispatch (Layer 1), " +
    "plus a scaffolded fuzzy reflex pass on before_agent_finalize (Layer 2, off by default).",

  register(api: PluginApi) {
    const config = (api.pluginConfig ?? {}) as ReflexGuardPluginConfig;

    // Layer 1 — deterministic outbound guard.
    const resolvedGuard = resolveOutboundGuardConfig(config.guard, {
      warn: (message: string) => console.warn(message),
    });
    const auditLogger = createAuditLogger(resolvedGuard.auditLogPath);

    if (resolvedGuard.enabled && resolvedGuard.terms.length > 0) {
      api.on("message_sending", createMessageSendingHandler(resolvedGuard, auditLogger), {
        registrationId: "reflex-guard-message-sending",
      });
      api.on("before_dispatch", createBeforeDispatchHandler(resolvedGuard, auditLogger), {
        registrationId: "reflex-guard-before-dispatch",
      });
    } else if (resolvedGuard.enabled) {
      console.warn(
        "[reflex-guard] guard.enabled is true but no valid sealed terms are configured — " +
          "shipping inert. Add terms via plugins.entries.reflex-guard.config.guard.terms " +
          "(see config/sealed-terms.example.json). Never commit real terms to this repo.",
      );
    }

    // Layer 2 scaffold — off by default (see src/reflex-finalize-hook.ts).
    const reflexHandler = createReflexFinalizeHandler(config.reflex);
    if (reflexHandler) {
      api.on("before_agent_finalize", reflexHandler, { registrationId: "reflex-guard-finalize" });
    }
  },
});
