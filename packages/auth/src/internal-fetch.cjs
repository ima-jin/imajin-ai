'use strict';

// Shared by the TypeScript auth package and the kernel's plain CJS WS server.
// These are small internal responses, NOT streaming inference: bound headers
// AND the complete body so sending headers alone cannot evade the deadline.
const INTERNAL_FETCH_TIMEOUT_MS = 5_000;

class InternalFetchError extends Error {
  constructor(targetPath, code, durationMs) {
    super(`Internal request failed: ${targetPath} (${code}, ${durationMs}ms)`);
    this.name = 'InternalFetchError';
    this.targetPath = targetPath;
    this.code = code;
    this.durationMs = durationMs;
  }
}

function causeCode(error) {
  const code = error?.cause?.code ?? error?.code;
  // Never carry arbitrary error messages (which can contain credentials).
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code : 'INTERNAL_FETCH_FAILED';
}

async function readResponse(url, init, signal) {
  const response = await globalThis.fetch(url, { ...init, signal });
  if (!response.body) return response;
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

/**
 * No retries. Abort the underlying socket AND race the whole operation: a
 * non-cooperative fetch implementation must not keep a request handler alive.
 * Callers retain their existing 401/403/503/null fail-closed contracts.
 */
async function internalFetch(url, init = {}, timeoutMs = INTERNAL_FETCH_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 100_000) {
    throw new TypeError('Internal fetch timeout must be 1..99999ms');
  }
  const targetPath = new URL(url).pathname;
  const started = Date.now();
  const controller = new AbortController();
  const callerSignal = init.signal;
  let timer;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new InternalFetchError(targetPath, 'INTERNAL_FETCH_ABORTED', Date.now() - started));
    };
    if (callerSignal?.aborted) return onAbort();
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new InternalFetchError(targetPath, 'INTERNAL_FETCH_TIMEOUT', Date.now() - started));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, readResponse(url, init, controller.signal)]);
  } catch (error) {
    const failure = error instanceof InternalFetchError ? error
      : new InternalFetchError(targetPath, causeCode(error), Date.now() - started);
    // Fixed fields only: no URL query, token, cookie, headers, body, or raw error.
    console.error(JSON.stringify({
      service: 'internal-fetch', targetPath: failure.targetPath,
      causeCode: failure.code, durationMs: failure.durationMs,
    }));
    throw failure;
  } finally {
    clearTimeout(timer);
    if (onAbort) callerSignal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { internalFetch, InternalFetchError, INTERNAL_FETCH_TIMEOUT_MS };
