/**
 * Break-glass observability (imajin-ai#1926 acceptance: "Break-glass fallback
 * tested and documented" + #1922 guardrail "Monitor: alert if fallback rate
 * exceeds threshold"). `GET /healthz` exposes this snapshot so an external
 * alert can be wired against `fallbackRate` without scraping logs.
 */
export interface HealthSnapshot {
  kernelOk: boolean;
  fallbackCount: number;
  fallbackRate: number;
  lastFallbackAt: string | null;
}

export class HealthTracker {
  private fallbackCount = 0;
  private totalAttempts = 0;
  private lastFallbackAt: string | null = null;
  private kernelOk = true;

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

  snapshot(): HealthSnapshot {
    return {
      kernelOk: this.kernelOk,
      fallbackCount: this.fallbackCount,
      fallbackRate: this.totalAttempts === 0 ? 0 : this.fallbackCount / this.totalAttempts,
      lastFallbackAt: this.lastFallbackAt,
    };
  }
}
