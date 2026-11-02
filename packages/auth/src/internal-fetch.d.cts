export const INTERNAL_FETCH_TIMEOUT_MS: number;
export class InternalFetchError extends Error {
  readonly targetPath: string;
  readonly code: string;
  readonly durationMs: number;
  constructor(targetPath: string, code: string, durationMs: number);
}
export function internalFetch(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response>;
