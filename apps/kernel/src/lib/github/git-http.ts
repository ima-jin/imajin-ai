/** Git smart HTTP only. No redirects, upstream errors, or upstream headers escape. */
export interface GitReadTarget {
  repo: string;
  suffix: 'info/refs?service=git-upload-pack' | 'git-upload-pack';
  contentType: string;
}

export function gitReadTarget(request: Request): GitReadTarget | Response {
  const url = new URL(request.url);
  const service = url.searchParams.getAll('service');
  if (url.pathname.includes('git-receive-pack') || service.includes('git-receive-pack')) {
    return gitError(403);
  }
  const match = /^\/github\/git\/([a-zA-Z0-9-]{1,39})\/([a-zA-Z0-9_.-]{1,100})\.git\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
  if (!match || match[1].startsWith('-') || match[1].endsWith('-')
    || match[2] === '.' || match[2] === '..' || match[2].includes('..')) return gitError(400);
  const repo = `${match[1]}/${match[2]}`;
  if (match[3] === 'info/refs') {
    if (request.method !== 'GET' || url.search !== '?service=git-upload-pack') return gitError(400);
    return { repo, suffix: 'info/refs?service=git-upload-pack', contentType: 'application/x-git-upload-pack-advertisement' };
  }
  if (request.method !== 'POST' || url.search !== ''
    || request.headers.get('content-type') !== 'application/x-git-upload-pack-request') return gitError(400);
  return { repo, suffix: 'git-upload-pack', contentType: 'application/x-git-upload-pack-result' };
}

export function gitError(status: number): Response {
  return new Response(status === 404 ? 'Not found' : 'Git request rejected', {
    status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}

/** Retain only a credential-sized tail; detect reflections even across chunk boundaries. */
function guardedBody(body: ReadableStream<Uint8Array>, credentials: readonly string[]): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const needles = credentials.map(value => Buffer.from(value));
  const tailSize = Math.max(...needles.map(value => value.length)) - 1;
  let pending = Buffer.alloc(0);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        pending = Buffer.concat([pending, Buffer.from(value ?? [])]);
        if (needles.some(needle => pending.includes(needle))) {
          await reader.cancel();
          controller.error(new Error('Git upstream stream rejected'));
          return;
        }
        const ready = done ? pending.length : Math.max(0, pending.length - tailSize);
        if (ready > 0) {
          controller.enqueue(pending.subarray(0, ready));
          pending = pending.subarray(ready);
        }
        if (done) controller.close();
      } catch {
        controller.error(new Error('Git upstream stream unavailable'));
      }
    },
    async cancel() { await reader.cancel().catch(() => undefined); },
  });
}

/** Called only inside the connector, after its unchanged requireGrantAndToken gate. */
export async function fetchGitRead(request: Request, target: GitReadTarget, token: string): Promise<Response> {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  const headers = new Headers({
    Authorization: `Basic ${encoded}`,
    'User-Agent': 'imajin-git-read',
    Accept: target.contentType,
    'Accept-Encoding': 'identity',
  });
  if (request.method === 'POST') headers.set('Content-Type', 'application/x-git-upload-pack-request');
  const protocol = request.headers.get('git-protocol');
  if (protocol === 'version=2') headers.set('Git-Protocol', protocol);
  try {
    const upstream = await fetch(`https://github.com/${target.repo}.git/${target.suffix}`, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : undefined,
      duplex: 'half',
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
      cache: 'no-store',
    } as RequestInit);
    if (upstream.status !== 200 || upstream.headers.get('content-type')?.split(';')[0] !== target.contentType) {
      await upstream.body?.cancel();
      return gitError([401, 403, 404].includes(upstream.status) ? 404 : 502);
    }
    if (!upstream.body) return gitError(502);
    return new Response(guardedBody(upstream.body, [token, encoded]), {
      headers: { 'Content-Type': target.contentType, 'Cache-Control': 'no-store' },
    });
  } catch {
    return gitError(502);
  }
}
