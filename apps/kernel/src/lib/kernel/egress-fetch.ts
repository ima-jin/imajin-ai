/**
 * Egress-safe fetch for owner-supplied inference endpoints (#1957).
 *
 * `egress-guard.ts` answers "is this URL safe to connect to", resolving DNS
 * once. This module is the other half: it actually makes the HTTP(S) request,
 * connecting to a PINNED address rather than letting the runtime re-resolve
 * the hostname itself — closing the gap between "validated" and "connected"
 * that a bare `fetch()` would reopen on every call (a DNS-rebinding target
 * could answer the validation lookup safely and the real connection
 * dangerously, if the two ever used different resolutions).
 *
 * Deliberately built on `node:http`/`node:https` rather than the global
 * `fetch` (undici): undici's pinning hook is a `Dispatcher`/`Agent` from the
 * `undici` package itself, which is not a dependency of this workspace, and
 * adding one solely to reach a private connect-pinning API was worse than
 * using the two request modules Node already ships. `http.request`/
 * `https.request` accept a `lookup` option that overrides DNS resolution
 * while leaving `hostname`/`host` (and therefore the `Host` header and, for
 * TLS, the SNI `servername`) untouched — exactly the "pin the connection,
 * keep the identity" split this needs.
 *
 * Redirects: Node's `http`/`https` modules never auto-follow a 3xx response,
 * so "no redirects are followed across hosts" holds trivially — a 3xx comes
 * back to the caller like any other status, the same as every other
 * upstream response.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIPv6 } from 'node:net';
import { Readable } from 'node:stream';
import { checkEgressTarget, type AddressFamily } from './egress-guard';
import { UpstreamTimeoutError, UpstreamUnavailableError } from '@/src/lib/inference/completions/errors';

/** Thrown when no `pinnedIp` was supplied and the fallback validation denied the URL. */
export class EgressDeniedError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(`egress_denied: ${message}`);
    this.name = 'EgressDeniedError';
    this.reason = reason;
  }
}

export interface EgressSafeFetchOptions {
  /** Name used in timeout/unavailable error messages, e.g. `'local'`. */
  connector: string;
  timeoutMs: number;
  /**
   * The address validated (and pinned) at `baseUrl` save time. When given,
   * NO fresh DNS resolution happens here — this is the "host pin after
   * first save" contract: a hostname's DNS record changing after the owner
   * saved it must not silently redirect a live connector.
   *
   * Omitting it falls back to validating (and connecting to) whatever the
   * hostname resolves to right now — used only where no prior pin exists.
   */
  pinnedIp?: string;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...headers };
}

/** Adapt a Node `IncomingMessage`'s header map into a standard `Headers`. */
function toWebHeaders(nodeHeaders: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }
  return headers;
}

/**
 * Fetch `rawUrl`, connecting to a pinned (or freshly validated) address
 * instead of letting the runtime resolve the hostname itself. Returns a
 * standard `Response` so callers (the OpenAI-compatible passthrough, the
 * local connector's model-list/probe helpers) need no special-casing beyond
 * choosing this over the plain `fetch()` they'd otherwise use.
 *
 * Throws `EgressDeniedError` (no `pinnedIp`, and the fallback validation
 * denied the URL), `UpstreamTimeoutError`, or `UpstreamUnavailableError` —
 * the same typed errors `fetchUpstream` throws, so the completions route's
 * existing error mapping needs no new branch.
 */
export async function egressSafeFetch(
  rawUrl: string,
  init: { method?: string; headers?: HeadersInit; body?: string },
  opts: EgressSafeFetchOptions,
): Promise<Response> {
  const url = new URL(rawUrl);

  let ip: string;
  let family: AddressFamily;
  if (opts.pinnedIp) {
    ip = opts.pinnedIp;
    family = isIPv6(opts.pinnedIp) ? 6 : 4;
  } else {
    const check = await checkEgressTarget(rawUrl);
    if (!check.ok) {
      throw new EgressDeniedError(check.reason, check.message);
    }
    ip = check.ip;
    family = check.family;
  }

  return performPinnedRequest(url, ip, family, init, opts);
}

function performPinnedRequest(
  url: URL,
  ip: string,
  family: AddressFamily,
  init: { method?: string; headers?: HeadersInit; body?: string },
  opts: EgressSafeFetchOptions,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const hostname = stripBrackets(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let settled = false;

    const req = requestFn(
      {
        hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: normalizeHeaders(init.headers),
        signal: controller.signal,
        // Overrides DNS resolution ONLY — `hostname` above (used for the
        // Host header and, on https, the TLS SNI servername) is untouched.
        // Node's own happy-eyeballs connect path calls this with
        // `{ all: true }` and expects an array of candidates back; older
        // call sites want the single-address `(err, address, family)` form.
        // Support both rather than assuming one.
        lookup: (_hostname, lookupOpts, callback) => {
          if (typeof lookupOpts === 'object' && lookupOpts !== null && 'all' in lookupOpts && lookupOpts.all) {
            (callback as (err: null, addresses: { address: string; family: AddressFamily }[]) => void)(
              null,
              [{ address: ip, family }],
            );
          } else {
            (callback as (err: null, address: string, family: AddressFamily) => void)(null, ip, family);
          }
        },
      },
      (res) => {
        clearTimeout(timer);
        settled = true;
        const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(body, {
          status: res.statusCode ?? 502,
          statusText: res.statusMessage ?? '',
          headers: toWebHeaders(res.headers),
        }));
      },
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      if (controller.signal.aborted) {
        reject(new UpstreamTimeoutError(opts.connector));
      } else {
        reject(new UpstreamUnavailableError(opts.connector, err instanceof Error ? err.message : String(err)));
      }
    });

    if (init.body) {
      req.end(init.body);
    } else {
      req.end();
    }
  });
}
