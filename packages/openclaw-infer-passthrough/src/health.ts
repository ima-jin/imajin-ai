/**
 * Break-glass observability (imajin-ai#1926 acceptance: "Break-glass fallback
 * tested and documented" + #1922 guardrail "Monitor: alert if fallback rate
 * exceeds threshold"). `GET /healthz` exposes this snapshot so an external
 * alert can be wired against `fallbackRate` without scraping logs.
 *
 * It also reflects passthrough liveness (imajin-ai#2453): `kernelOk` only tracks
 * the kernel-then-break-glass decision, so a request that ends in a 5xx —
 * a mapped 502 (mint unreachable, no fallback, fallback failed) or an unexpected
 * 500 — would otherwise leave `/healthz` green while completions fail. Every 5xx
 * the shim returns is recorded in `passthroughOk` / `lastPassthroughError`.
 */
export interface PassthroughError {
  status: number;
  at: string;
}

export interface HealthSnapshot {
  kernelOk: boolean;
  fallbackCount: number;
  fallbackRate: number;
  lastFallbackAt: string | null;
  /** False once a request ended in a 5xx; back to true on the next successful (< 400) response. */
  passthroughOk: boolean;
  passthroughErrorCount: number;
  lastPassthroughError: PassthroughError | null;
}

export class HealthTracker {
  private fallbackCount = 0;
  private totalAttempts = 0;
  private lastFallbackAt: string | null = null;
  private kernelOk = true;
  private passthroughOk = true;
  private passthroughErrorCount = 0;
  private lastPassthroughError: PassthroughError | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  recordKernelSuccess(): void {
    this.totalAttempts += 1;
    this.kernelOk = true;
  }

  recordFallback(): void {
    this.totalAttempts += 1;
    this.fallbackCount += 1;
    this.kernelOk = false;
    this.lastFallbackAt = new Date(this.now()).toISOString();
  }

  /**
   * Record the HTTP status the shim answered a proxied request with. A 5xx
   * (including a mapped 502) marks the passthrough unhealthy; a 2xx/3xx marks
   * it healthy again; a 4xx is a client/grant error and leaves the state
   * untouched, so it can neither raise nor mask an outage.
   */
  recordPassthroughStatus(status: number): void {
    if (status >= 500) {
      this.passthroughOk = false;
      this.passthroughErrorCount += 1;
      this.lastPassthroughError = { status, at: new Date(this.now()).toISOString() };
    } else if (status < 400) {
      this.passthroughOk = true;
    }
  }

  snapshot(): HealthSnapshot {
    return {
      kernelOk: this.kernelOk,
      fallbackCount: this.fallbackCount,
      fallbackRate: this.totalAttempts === 0 ? 0 : this.fallbackCount / this.totalAttempts,
      lastFallbackAt: this.lastFallbackAt,
      passthroughOk: this.passthroughOk,
      passthroughErrorCount: this.passthroughErrorCount,
      lastPassthroughError: this.lastPassthroughError ? { ...this.lastPassthroughError } : null,
    };
  }
}
