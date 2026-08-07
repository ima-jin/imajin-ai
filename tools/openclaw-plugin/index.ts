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
import { ImajinWsService } from "./src/ws-service.js";
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
      const wsNotifications = config.wsNotifications as {
        injectScopes?: string[];
        targetSession?: string;
      } | undefined;
      const injectScopes = new Set(wsNotifications?.injectScopes ?? []);
      const targetSession = wsNotifications?.targetSession;

      // Resolve injection APIs — enqueueSystemEvent is on api.runtime.system (always wired)
      const enqueueSystemEvent = api.runtime?.system?.enqueueSystemEvent;
      const requestHeartbeat = api.runtime?.system?.requestHeartbeat;
      console.log(`[imajin-ws] injection APIs: enqueueSystemEvent=${!!enqueueSystemEvent}, requestHeartbeat=${!!requestHeartbeat}`);

      wsService.onFrame((frame) => {
        if (frame.type === "notification") {
          const nf = frame as { type: string; id: string; scope: string; title: string; body: string; data?: Record<string, unknown>; createdAt: string };
          console.log(
            `[imajin-ws] notification: ${nf.scope} — ${nf.title}`,
          );

          // Check if this scope triggers agent wake-up
          if (injectScopes.has(nf.scope)) {
            const dataJson = nf.data ? JSON.stringify(nf.data, null, 2) : "(none)";
            const eventText = [
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
            ].filter(Boolean).join("\n");

            if (enqueueSystemEvent) {
              try {
                enqueueSystemEvent({
                  type: "plugin",
                  source: "imajin-ws",
                  text: eventText,
                });
                console.log(`[imajin-ws] enqueued system event for ${nf.scope}`);
              } catch (err: any) {
                console.error(`[imajin-ws] enqueueSystemEvent failed:`, err?.message ?? err);
                if (requestHeartbeat) {
                  requestHeartbeat({ source: "other", intent: "event", reason: `warp notification: ${nf.scope}` });
                  console.log(`[imajin-ws] fallback: requested heartbeat for ${nf.scope}`);
                }
              }
            } else if (requestHeartbeat) {
              requestHeartbeat({ source: "other", intent: "event", reason: `warp notification: ${nf.scope}` });
              console.log(`[imajin-ws] no enqueueSystemEvent, requested heartbeat for ${nf.scope}`);
            } else {
              console.warn(`[imajin-ws] no injection API available for ${nf.scope}`);
            }
          }
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
