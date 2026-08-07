/**
 * OpenClaw Imajin Plugin
 *
 * Connects an OpenClaw agent to the Imajin network.
 * Registers tools for the five primitives: identity, attestation,
 * attribution (.fair), settlement, and discovery.
 *
 * Config (openclaw.json):
 *   "imajin": {
 *     "enabled": true,
 *     "config": {
 *       "nodeUrl": "https://jin.imajin.ai",
 *       "did": "did:imajin:...",
 *       "keypairPath": "/path/to/.jin-identity.json"
 *     }
 *   }
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ImajinChat } from "./src/chat.js";
import { ImajinClient } from "./src/client.js";
import { ImajinWsService, type NotificationFrame } from "./src/ws-service.js";
import {
  createIdentityTool,
  createAttestTool,
  createTransactTool,
  createFairTool,
  createDiscoverTool,
  createMediaTool,
  createWarpTool,
  createInferTool,
  createChatTool,
} from "./src/tools.js";

/** `plugins.entries.imajin.config.wsNotifications` (openclaw.json). */
interface WsNotificationsConfig {
  /** Notification scopes that should wake the agent, e.g. `warp.run.completed`. */
  injectScopes?: string[];
  /** Exact session key to inject into, e.g. `agent:main:telegram:direct:8321865723`. */
  targetSession?: string;
}

// A queued notification is stale once the run it describes is old news; the
// host drops the record instead of prepending it to some much later turn.
const INJECTION_TTL_MS = 15 * 60_000;
// Hard cap on the injected block so a pathological `data` payload cannot eat
// the session's context window. The host also caps at 32KB and silently
// refuses anything larger, which would look like a lost notification.
const MAX_INJECTED_CHARS = 4_000;
const MAX_DATA_JSON_CHARS = 2_000;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function buildNotificationText(nf: NotificationFrame): string {
  let dataJson = "(none)";
  if (nf.data) {
    try {
      dataJson = truncate(JSON.stringify(nf.data, null, 2), MAX_DATA_JSON_CHARS);
    } catch {
      dataJson = "(unserializable)";
    }
  }
  const text = [
    `[Warp Notification: ${nf.scope}]`,
    "",
    nf.title,
    nf.body ? `\n${nf.body}` : "",
    "",
    `Notification ID: ${nf.id}`,
    `Received: ${nf.createdAt}`,
    `Data:\n\`\`\`json\n${dataJson}\n\`\`\``,
    "",
    "Review this event and take appropriate action.",
  ]
    .filter(Boolean)
    .join("\n");
  return truncate(text, MAX_INJECTED_CHARS);
}

/**
 * Builds the WS-notification → agent-session injector (#1672).
 *
 * The returned function is called from the WebSocket frame callback, which runs
 * on the socket's event loop turn and **not** inside an agent turn. Every host
 * API it touches therefore has to be told which session to act on:
 *
 * - `api.session.workflow.enqueueNextTurnInjection({ sessionKey, text, … })` is
 *   the durable, session-keyed plugin seam. The host persists the record on the
 *   session entry and drains it while building the next turn's prompt, so it
 *   survives a gateway restart and `idempotencyKey` makes redelivery a no-op.
 * - `api.runtime.system.enqueueSystemEvent(text, { sessionKey })` is the
 *   in-memory fallback. Note the **two-argument** signature: the previous code
 *   passed a single `{ type, source, text }` object, so the host's `options`
 *   parameter was `undefined` and `requireSessionKey(options.sessionKey)` threw
 *   `Cannot read properties of undefined (reading 'sessionKey')`. The API was
 *   never session-scoped — it just needs the session key passed explicitly.
 * - `api.runtime.system.requestHeartbeat({ source: "notifications-event",
 *   intent: "immediate", reason: "wake", sessionKey })` is what actually wakes
 *   the agent. That exact quadruple is the host's "targeted immediate system
 *   event wake": it is the only combination that bypasses the heartbeat
 *   enrolment, quiet-hours and empty-`HEARTBEAT.md` gates for a specific
 *   session. The previous `{ source: "other", intent: "event" }` call was
 *   treated as an ordinary heartbeat tick with no session target, which is why
 *   it fired without ever waking this session or carrying the payload.
 *   `heartbeat: { target: "last" }` routes the reply to the session's last
 *   active channel instead of the default `target: "none"` suppression.
 */
function createNotificationInjector(
  api: any,
  wsNotifications: WsNotificationsConfig | undefined,
): (nf: NotificationFrame) => Promise<void> {
  const injectScopes = new Set(wsNotifications?.injectScopes ?? []);
  const targetSession = wsNotifications?.targetSession?.trim();

  // Prefer the grouped session facade; `api.enqueueNextTurnInjection` is the
  // deprecated flat alias kept for hosts that predate the `api.session` group.
  const enqueueNextTurnInjection:
    | ((injection: {
        sessionKey: string;
        text: string;
        idempotencyKey?: string;
        placement?: "prepend_context" | "append_context";
        ttlMs?: number;
      }) => Promise<{ enqueued: boolean; id: string; sessionKey: string }>)
    | undefined = api.session?.workflow?.enqueueNextTurnInjection ?? api.enqueueNextTurnInjection;
  const enqueueSystemEvent:
    | ((text: string, options: { sessionKey: string; contextKey?: string }) => boolean)
    | undefined = api.runtime?.system?.enqueueSystemEvent;
  const requestHeartbeat:
    | ((opts: {
        source: string;
        intent: string;
        reason?: string;
        sessionKey?: string;
        heartbeat?: { target?: string };
      }) => void)
    | undefined = api.runtime?.system?.requestHeartbeat;

  console.log(
    `[imajin-ws] injection APIs: enqueueNextTurnInjection=${!!enqueueNextTurnInjection}, ` +
      `enqueueSystemEvent=${!!enqueueSystemEvent}, requestHeartbeat=${!!requestHeartbeat}`,
  );
  if (injectScopes.size === 0) {
    console.log("[imajin-ws] no wsNotifications.injectScopes configured — notifications are log-only");
  } else if (!targetSession) {
    console.warn(
      "[imajin-ws] wsNotifications.injectScopes is set but wsNotifications.targetSession is missing — " +
        "injection needs an explicit session key and will be skipped",
    );
  } else {
    console.log(
      `[imajin-ws] injecting [${[...injectScopes].join(", ")}] → session ${targetSession}`,
    );
  }

  return async (nf: NotificationFrame): Promise<void> => {
    if (!injectScopes.has(nf.scope) || !targetSession) {
      return;
    }

    const text = buildNotificationText(nf);
    let queuedVia: "next-turn-injection" | "system-event" | undefined;

    if (enqueueNextTurnInjection) {
      try {
        const result = await enqueueNextTurnInjection({
          sessionKey: targetSession,
          text,
          // The kernel notification id is already unique per event, so a
          // reconnect that replays the frame cannot double-inject.
          idempotencyKey: `imajin-ws:${nf.id}`,
          placement: "prepend_context",
          ttlMs: INJECTION_TTL_MS,
        });
        if (result?.enqueued) {
          queuedVia = "next-turn-injection";
        } else {
          // Reached when the session row does not exist yet, the queue is full,
          // or `hooks.allowPromptInjection` is false for this plugin.
          console.warn(
            `[imajin-ws] next-turn injection refused for ${nf.scope} (session ${targetSession}) — ` +
              "falling back to the system-event queue",
          );
        }
      } catch (err: any) {
        console.error(
          `[imajin-ws] enqueueNextTurnInjection failed for ${nf.scope}:`,
          err?.message ?? err,
        );
      }
    }

    if (!queuedVia && enqueueSystemEvent) {
      try {
        enqueueSystemEvent(text, {
          sessionKey: targetSession,
          contextKey: `imajin-ws:${nf.scope}`,
        });
        queuedVia = "system-event";
      } catch (err: any) {
        console.error(`[imajin-ws] enqueueSystemEvent failed for ${nf.scope}:`, err?.message ?? err);
      }
    }

    if (!queuedVia) {
      console.error(
        `[imajin-ws] dropped ${nf.scope} — no injection API accepted the payload for ${targetSession}`,
      );
      return;
    }

    if (!requestHeartbeat) {
      // The payload is queued and will be picked up by the session's next turn,
      // but nothing will start that turn on its own.
      console.warn(
        `[imajin-ws] queued ${nf.scope} via ${queuedVia} but requestHeartbeat is unavailable — ` +
          "the agent will only see it on its next turn",
      );
      return;
    }

    requestHeartbeat({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey: targetSession,
      heartbeat: { target: "last" },
    });
    console.log(`[imajin-ws] injected ${nf.scope} → ${targetSession} via ${queuedVia}, woke session`);
  };
}

export default definePluginEntry({
  id: "imajin",
  name: "Imajin Network",
  description:
    "Connect to the Imajin sovereign identity and settlement network. " +
    "Provides tools for identity lookup, attestations, .fair attribution, " +
    "MJNx/MJN settlement, and network discovery.",

  register(api: any) {
    const config = api.pluginConfig as {
      nodeUrl?: string;
      did?: string;
      keypairPath?: string;
      actAs?: string;
      wsNotifications?: WsNotificationsConfig;
    };

    if (!config?.nodeUrl) {
      console.warn(
        "[imajin-plugin] no nodeUrl configured. Set plugins.entries.imajin.config.nodeUrl",
      );
      return;
    }

    const client = new ImajinClient({
      nodeUrl: config.nodeUrl,
      did: config.did,
      keypairPath: config.keypairPath,
      actAs: config.actAs,
    });

    // Register primitive tools
    api.registerTool(createIdentityTool(client));
    api.registerTool(createAttestTool(client));
    api.registerTool(createTransactTool(client));
    api.registerTool(createFairTool(client));
    api.registerTool(createDiscoverTool(client));
    api.registerTool(createMediaTool(client));
    api.registerTool(createWarpTool(client));
    api.registerTool(createInferTool(client));

    // Chat — requires keypair for auth
    if (config.keypairPath) {
      try {
        const agentDid = config.did || "";
        const chat = new ImajinChat(client, agentDid);
        api.registerTool(createChatTool(chat));
      } catch (err) {
        console.error("[imajin-plugin] failed to register chat tool:", err);
      }
    }

    // Background WebSocket service for real-time notifications (#1653)
    console.log("[imajin-plugin] keypairPath:", config.keypairPath ? "configured" : "missing");
    if (config.keypairPath) {
      console.log("[imajin-plugin] registering imajin-ws service");
      const wsService = new ImajinWsService(
        {
          nodeUrl: config.nodeUrl,
          did: config.did,
          keypairPath: config.keypairPath,
          actAs: config.actAs,
        },
      );

      // WS notification → agent session injection (#1672)
      const injector = createNotificationInjector(api, config.wsNotifications);

      wsService.onFrame((frame) => {
        if (frame.type === "notification") {
          const nf = frame as NotificationFrame;
          console.log(
            `[imajin-ws] notification: ${nf.scope} — ${nf.title}`,
          );
          // The WS socket callback runs outside any agent turn, so injection is
          // fire-and-forget: never let a rejected promise reach the socket.
          void injector(nf).catch((err: unknown) => {
            console.error(`[imajin-ws] injection failed for ${nf.scope}:`, err);
          });
        } else {
          console.log(`[imajin-ws] frame: type=${frame.type}`, JSON.stringify(frame).slice(0, 200));
        }
      });

      api.registerService({
        id: "imajin-ws",
        start: async () => {
          console.log("[imajin-ws] service start called");
          try {
            await wsService.start();
            console.log("[imajin-ws] service started successfully");
          } catch (err) {
            console.error("[imajin-ws] service start failed:", err);
          }
        },
        stop: async () => {
          console.log("[imajin-ws] service stop called");
          wsService.stop();
        },
      });
    }

    // TODO: registerMemoryCorpusSupplement — agent's chain as searchable memory
    // TODO: registerHook("before_tool_call") — entity context decorator
    // TODO: registerHttpRoute — webhook receiver for Imajin events
    // TODO: registerChannel — Imajin chat as a full messaging channel (receive + send)
  },
});
