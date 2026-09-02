/**
 * WS connection lifecycle for the Imajin chat bridge (imajin-ai#1932).
 *
 * Ported pattern from `openclaw-imajin-plugin/src/ws-service.ts` (separate
 * repo/package, re-implemented here, not imported): authenticate via
 * Ed25519 challenge-response, connect to the kernel's `/chat/ws`, reconnect
 * with capped exponential backoff, and hand parsed frames to a handler.
 * Auth-failure frames force a fresh challenge-response rather than retrying
 * a cookie the kernel just rejected.
 */
import { authenticate, type ChallengeResponseConfig } from './auth/challenge-response.js';
import { isAuthFailureFrame, parseFrame } from './imajin-client.js';
import { toWebSocketUrl } from './url-utils.js';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export function computeReconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

export interface WsConnectionLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const consoleLogger: WsConnectionLogger = {
  info: (msg, meta) => console.log(`[imajin-chat] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[imajin-chat] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[imajin-chat] ${msg}`, meta ?? ''),
};

export type FrameHandler = (raw: string) => void;

export class ImajinChatConnection {
  private ws: WebSocket | null = null;
  private cookie: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly logger: WsConnectionLogger;

  constructor(
    private readonly config: ChallengeResponseConfig,
    private readonly onFrame: FrameHandler,
    logger: WsConnectionLogger = consoleLogger,
  ) {
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempt = 0;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'service stopping');
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const session = this.cookie ? { cookie: this.cookie } : await authenticate(this.config);
      this.cookie = session.cookie;

      const wsUrl = `${toWebSocketUrl(this.config.kernelBaseUrl)}/chat/ws`;
      this.logger.info('connecting', { wsUrl });

      // Native WebSocket cannot set a Cookie header on the upgrade request —
      // this bridge authenticates over HTTP first and relies on the kernel's
      // deferred-auth handshake (auth_required -> token exchange) exactly as
      // openclaw-imajin-plugin's native-WebSocket fallback does. If a future
      // revision needs the `ws` package's Cookie-header path, add it here.
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => {
        this.logger.info('connected');
        this.reconnectAttempt = 0;
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        const frame = parseFrame(raw);
        if (!frame) return;
        if (isAuthFailureFrame(frame)) {
          this.logger.warn('auth rejected by kernel — refreshing session and reconnecting');
          this.cookie = null;
          ws.close(4001, 'auth refresh');
          return;
        }
        this.onFrame(raw);
      });
      ws.addEventListener('close', (event: CloseEvent) => {
        this.logger.warn('disconnected', { code: event.code, reason: event.reason });
        this.ws = null;
        this.scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        ws.close();
      });
      this.ws = ws;
    } catch (err) {
      this.logger.error('connect failed', { err: err instanceof Error ? err.message : String(err) });
      this.cookie = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = computeReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
