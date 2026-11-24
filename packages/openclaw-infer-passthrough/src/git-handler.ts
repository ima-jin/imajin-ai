import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readAgentCredential } from './agent-handler.js';
import { stripTrailingSlashes } from './url-utils.js';
import type { ProxyConfig } from './types.js';

function reject(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end('Git request rejected');
}

function gitHeaders(req: IncomingMessage, token: string): Headers {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  for (const name of ['content-type', 'git-protocol', 'x-acting-for', 'x-acting-as']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

/** Agent mode only; no host principal, minting, retries or direct GitHub fallback. */
export async function forwardGitRequest(
  config: Pick<ProxyConfig, 'kernelBaseUrl' | 'kernelTimeoutMs'>,
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  res.once('close', disconnected);
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.includes('git-receive-pack') || url.searchParams.getAll('service').includes('git-receive-pack')) {
      req.resume();
      reject(res, 403);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      req.resume();
      reject(res, 400);
      return;
    }
    const credential = readAgentCredential(req.headers, false);
    if ('status' in credential) {
      req.resume();
      reject(res, 401);
      return;
    }
    const headers = gitHeaders(req, credential.token);
    const upstream = await fetch(`${stripTrailingSlashes(config.kernelBaseUrl)}${url.pathname}${url.search}`, {
      method: req.method, headers, redirect: 'manual',
      body: req.method === 'POST' ? Readable.toWeb(req) : undefined,
      duplex: 'half',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(config.kernelTimeoutMs, 120_000))]),
    } as RequestInit);
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      reject(res, [400, 401, 403, 404, 409].includes(upstream.status) ? upstream.status : 502);
      return;
    }
    const contentType = upstream.headers.get('content-type');
    if (!upstream.body || ![
      'application/x-git-upload-pack-advertisement', 'application/x-git-upload-pack-result',
    ].includes(contentType ?? '')) {
      await upstream.body?.cancel();
      reject(res, 502);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType!, 'Cache-Control': 'no-store' });
    await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res);
  } catch {
    // Never route credential-bearing network/stream errors to the server's general logger.
    if (res.headersSent) res.destroy();
    else reject(res, 502);
  } finally {
    res.off('close', disconnected);
    controller.abort();
  }
}
