/**
 * Warp connector error types (#1428).
 *
 * Deliberately dependency-free, mirroring `src/lib/vault/errors.ts`. The error
 * mapping used by the routes must be importable without dragging in the DB-backed
 * identity lookup that `dispatch.ts` needs, so the class lives here rather than
 * alongside the client that throws it.
 */

/**
 * A non-2xx response from Warp, reduced to RFC-7807 problem metadata.
 *
 * Deliberately narrow: only fields Warp documents as describing the *problem* are
 * carried over, so a route can return this to a caller without having to
 * re-audit whether the upstream body echoed the request (and with it, the sealed
 * Agent key).
 */
export class WarpApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly retryable: boolean | undefined;
  readonly traceId: string | undefined;

  constructor(
    message: string,
    params: {
      status: number;
      code?: string;
      detail?: string;
      retryable?: boolean;
      traceId?: string;
    },
  ) {
    super(message);
    this.name = 'WarpApiError';
    this.status = params.status;
    this.code = params.code;
    this.detail = params.detail;
    this.retryable = params.retryable;
    this.traceId = params.traceId;
  }
}
