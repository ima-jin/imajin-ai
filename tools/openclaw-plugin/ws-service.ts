/**
 * Imajin WebSocket notification service.
 *
 * Background service that maintains a persistent WebSocket connection to the
 * kernel's chat/notification endpoint. Authenticates via Ed25519 challenge-response
 * (same flow as ImajinClient), handles heartbeat/reconnect, and parses inbound
 * frames (chat messages + notification pushes from #1645).
 *
 * Uses native WebSocket (Node 22+) — no external `ws` dependency needed.
 * Auth cookie is passed via query param since native WS doesn't support headers.
 *
 * Registered via api.registerService() in the plugin entry.
 */

import { readFile } from "node:fs/promises";

// --- Types ---

export interface WsServiceConfig {
  nodeUrl: string;
  did?: string;
  keypairPath?: string;
  actAs?: string;
}

export interface NotificationFrame {
  type: "notification";
  id: string;
  scope: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface ChatMessageFrame {
  type: "chat_message";
  conversationDid: string;
  message: {
    id: string;
    fromDid: string;
    content: unknown;
    createdAt: string;
  };
}

type InboundFrame = NotificationFrame | ChatMessageFrame | { type: string; [k: string]: unknown };

export type FrameHandler = (frame: InboundFrame) => void;

interface Keypair {
  did: string;
  publicKey: string;
  publicKeyHex: string;
  privateKey: string;
}

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

// --- Service ---

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export class ImajinWsService {
  private ws: WebSocket | null = null;
  private keypair: Keypair | null = null;
  private sessionCookie: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private handlers: FrameHandler[] = [];
  private logger: Logger;

  constructor(
    private config: WsServiceConfig,
    logger?: Logger,
  ) {
    this.logger = logger ?? {
      info: (msg, ...a) => console.log(`[imajin-ws] ${msg}`, ...a),
      warn: (msg, ...a) => console.warn(`[imajin-ws] ${msg}`, ...a),
      error: (msg, ...a) => console.error(`[imajin-ws] ${msg}`, ...a),
    };
  }

  /** Register a handler for inbound frames. */
  onFrame(handler: FrameHandler): void {
    this.handlers.push(handler);
  }

  /** Start the WebSocket connection (called by plugin service lifecycle). */
  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempt = 0;
    await this.connect();
  }

  /** Stop the WebSocket connection and cancel reconnects. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "service stopping");
      this.ws = null;
    }
    this.logger.info("stopped");
  }

  // --- Auth (mirrors ImajinClient) ---

  private async loadKeypair(): Promise<Keypair> {
    if (this.keypair) return this.keypair;
    if (!this.config.keypairPath) {
      throw new Error("No keypairPath configured — cannot authenticate WS");
    }
    const raw = await readFile(this.config.keypairPath, "utf-8");
    const parsed = JSON.parse(raw);
    this.keypair = {
      did: parsed.did,
      publicKey: parsed.publicKey || parsed.keypair?.publicKey || "",
      publicKeyHex: parsed.publicKeyHex || parsed.keypair?.publicKey || "",
      privateKey: parsed.privateKey || parsed.keypair?.privateKey || "",
    };
    return this.keypair;
  }

  private async signChallenge(challengeHex: string, privateKeyHex: string): Promise<string> {
    const ed = await import("@noble/ed25519");
    const { sha512 } = await import("@noble/hashes/sha2.js");

    if ("hashes" in ed && ed.hashes) {
      (ed.hashes as any).sha512 = sha512;
    } else {
      try {
        ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
      } catch {}
    }

    const messageBytes = new TextEncoder().encode(challengeHex);
    const privKeyBytes = hexToBytes(privateKeyHex);
    const signature = await ed.signAsync(messageBytes, privKeyBytes);
    return bytesToHex(signature);
  }

  /** Authenticate via HTTP challenge-response, extract session token. */
  private async authenticate(): Promise<string> {
    const keypair = await this.loadKeypair();
    const baseUrl = this.config.nodeUrl.replace(/\/$/, "");

    const challengeRes = await fetch(`${baseUrl}/auth/api/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: keypair.did }),
    });

    if (!challengeRes.ok) {
      throw new Error(`WS auth challenge failed (${challengeRes.status})`);
    }

    const { challengeId, challenge } = (await challengeRes.json()) as {
      challengeId: string;
      challenge: string;
    };

    const signature = await this.signChallenge(challenge, keypair.privateKey);

    const verifyRes = await fetch(`${baseUrl}/auth/api/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, signature }),
    });

    if (!verifyRes.ok) {
      throw new Error(`WS auth verify failed (${verifyRes.status})`);
    }

    // Extract session cookie — format: "name=value; Path=...; HttpOnly; ..."
    const setCookie = verifyRes.headers.get("set-cookie");
    if (!setCookie) {
      throw new Error("WS auth: no session cookie in response");
    }
    const match = setCookie.match(/([^=]+)=([^;]+)/);
    if (!match) {
      throw new Error("WS auth: could not parse session cookie");
    }

    this.sessionCookie = `${match[1]}=${match[2]}`;
    return this.sessionCookie;
  }

  // --- WebSocket lifecycle ---

  private async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      const cookie = this.sessionCookie ?? (await this.authenticate());

      // Derive WS URL from nodeUrl
      const baseUrl = this.config.nodeUrl.replace(/\/$/, "");
      const wsUrl = baseUrl.replace(/^http/, "ws") + "/chat/ws";

      this.logger.info(`connecting to ${wsUrl}`);

      // Native WebSocket (Node 22+) doesn't support custom headers.
      // The kernel WS handler reads the session from the upgrade request.
      // We pass the session cookie via a protocol header that the ws
      // upgrade can read, or fall back to post-connect auth message.
      //
      // Strategy: try ws package first (supports headers), fall back to
      // native WebSocket with post-connect auth.
      let ws: WebSocket;
      try {
        // Try importing ws (available if OpenClaw hoists it)
        const { default: WsClient } = await import("ws" as string);
        ws = new WsClient(wsUrl, {
          headers: {
            Cookie: cookie,
            ...(this.config.did ? { "X-Agent-DID": this.config.did } : {}),
          },
        }) as unknown as WebSocket;
      } catch {
        // Fall back to native WebSocket — authenticate post-connect
        ws = new WebSocket(wsUrl);
      }

      ws.addEventListener("open", () => {
        this.logger.info("connected");
        this.reconnectAttempt = 0;

        // If using native WebSocket (no cookie header), send auth message
        if (!("_socket" in ws)) {
          ws.send(JSON.stringify({
            type: "auth",
            cookie,
            did: this.config.did,
          }));
        }

        // Register for actAs DID notifications too (#1545 pattern).
        // When the agent acts on behalf of a principal, it needs to
        // receive that principal's notifications.
        if (this.config.actAs) {
          this.logger.info(`registering actAs DID: ${this.config.actAs}`);
          ws.send(JSON.stringify({
            type: "register_also",
            did: this.config.actAs,
          }));
        }

        this.startHeartbeat(ws);
      });

      ws.addEventListener("message", (event: MessageEvent | { data: unknown }) => {
        this.resetHeartbeatTimeout();
        try {
          const raw = typeof event === "object" && "data" in event
            ? String(event.data)
            : String(event);

          // Ignore pong/heartbeat responses
          if (raw === "pong" || raw === "") return;

          const frame = JSON.parse(raw) as InboundFrame;
          this.dispatchFrame(frame);
        } catch (err) {
          this.logger.warn(`failed to parse WS frame: ${err}`);
        }
      });

      ws.addEventListener("close", (event: CloseEvent | { code?: number; reason?: string }) => {
        const code = "code" in event ? event.code : 0;
        const reason = "reason" in event ? event.reason : "";
        this.logger.warn(`disconnected (code=${code}, reason=${reason})`);
        this.clearTimers();
        this.ws = null;
        this.scheduleReconnect();
      });

      ws.addEventListener("error", (event: Event | { message?: string }) => {
        const msg = "message" in event ? event.message : "unknown error";
        this.logger.error(`ws error: ${msg}`);
        // close event will fire after error, which triggers reconnect
      });

      this.ws = ws;
    } catch (err) {
      this.logger.error(`connect failed: ${err}`);
      this.sessionCookie = null; // Force re-auth on next attempt
      this.scheduleReconnect();
    }
  }

  private dispatchFrame(frame: InboundFrame): void {
    for (const handler of this.handlers) {
      try {
        handler(frame);
      } catch (err) {
        this.logger.error(`frame handler error: ${err}`);
      }
    }
  }

  // --- Heartbeat ---

  private startHeartbeat(ws: WebSocket): void {
    this.clearTimers();
    this.heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
        this.heartbeatTimeout = setTimeout(() => {
          this.logger.warn("heartbeat timeout — closing connection");
          ws.close();
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  // --- Reconnect ---

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;

    this.logger.info(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// --- Hex utilities ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
