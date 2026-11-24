import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGitRead, gitReadTarget, type GitReadTarget } from '../git-http';

const root = 'https://kernel.test/github/git/ima-jin/private.git/';
const advertisement = 'application/x-git-upload-pack-advertisement';
const request = () => new Request(`${root}info/refs?service=git-upload-pack`);
const target = (): GitReadTarget => {
  const result = gitReadTarget(request());
  if (result instanceof Response) throw new Error('invalid test target');
  return result;
};
afterEach(() => vi.unstubAllGlobals());

describe('git read protocol validation', () => {
  it('accepts only advertisement and upload-pack', () => {
    expect(target().repo).toBe('ima-jin/private');
    expect(gitReadTarget(new Request(`${root}git-upload-pack`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request' }, body: '0000',
    }))).toMatchObject({ repo: 'ima-jin/private', suffix: 'git-upload-pack' });
  });
  it.each([
    'git-receive-pack', 'info/refs?service=git-receive-pack',
    'info/refs?service=git-upload-pack&service=git-receive-pack',
  ])('rejects push %s', suffix => {
    expect(gitReadTarget(new Request(`${root}${suffix}`))).toMatchObject({ status: 403 });
  });
  it.each([
    `${root}info/refs`, `${root}info/refs?service=other`,
    `${root}info/refs?service=git-upload-pack&extra=1`,
    `${root}info/refs?service=git-upload-pack&service=git-upload-pack`,
    `${root}HEAD`, `${root}objects/pack/a.pack`, `${root}git-upload-pack`,
    `${root}info/refs/?service=git-upload-pack`,
    'https://kernel.test/github/git/-owner/repo.git/info/refs?service=git-upload-pack',
    'https://kernel.test/github/git/owner-/repo.git/info/refs?service=git-upload-pack',
    'https://kernel.test/github/git/owner/a..b.git/info/refs?service=git-upload-pack',
    'https://kernel.test/github/git/owner/%2e%2e.git/info/refs?service=git-upload-pack',
    'https://kernel.test/github/git/owner/a%2fb.git/info/refs?service=git-upload-pack',
    'https://kernel.test/github/git/owner/a%5cb.git/info/refs?service=git-upload-pack',
    'https://kernel.test/github/git/owner/a%40evil.git/info/refs?service=git-upload-pack',
    `https://kernel.test/github/git/${'a'.repeat(40)}/repo.git/info/refs?service=git-upload-pack`,
    `https://kernel.test/github/git/owner/${'a'.repeat(101)}.git/info/refs?service=git-upload-pack`,
  ])('refuses invalid path or service case %#', url => {
    expect(gitReadTarget(new Request(url))).toMatchObject({ status: 400 });
  });
  it('rejects wrong methods, POST content type and POST query parameters', () => {
    expect(gitReadTarget(new Request(request(), { method: 'POST' }))).toMatchObject({ status: 400 });
    for (const suffix of ['git-upload-pack', 'git-upload-pack?service=git-upload-pack']) {
      expect(gitReadTarget(new Request(`${root}${suffix}`, { method: 'POST' }))).toMatchObject({ status: 400 });
    }
  });
});

describe('sealed credential upstream transport', () => {
  it('pins GitHub, injects only Authorization, strips every upstream header, and streams binary intact', async () => {
    const token = randomBytes(32).toString('hex');
    const bytes = randomBytes(1024 * 256);
    const upstream = vi.fn().mockResolvedValue(new Response(bytes, {
      headers: {
        'Content-Type': advertisement, 'WWW-Authenticate': token, 'Set-Cookie': token,
        Location: `https://evil.test/${token}`, 'x-reflected-token': token,
      },
    }));
    vi.stubGlobal('fetch', upstream);
    const response = await fetchGitRead(request(), target(), token);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://github.com/ima-jin/private.git/info/refs?service=git-upload-pack');
    expect(init.redirect).toBe('manual');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
    headers.delete('authorization');
    expect(JSON.stringify({ url, ...init, headers: [...headers] })).not.toContain(token);
    expect([...response.headers.keys()]).toEqual(['cache-control', 'content-type']);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
  it.each([301, 302, 307, 308, 401, 403, 404, 500])('discards upstream body and headers on %s', async status => {
    const token = randomBytes(32).toString('hex');
    const fetcher = vi.fn().mockResolvedValue(new Response(token, {
      status, headers: { Location: `https://evil.test/${token}`, 'WWW-Authenticate': token, 'Set-Cookie': token },
    }));
    vi.stubGlobal('fetch', fetcher);
    const response = await fetchGitRead(request(), target(), token);
    expect(response.status).toBe([401, 403, 404].includes(status) ? 404 : 502);
    expect(await response.text()).not.toContain(token);
    expect(JSON.stringify([...response.headers])).not.toContain(token);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('rejects reflected credentials even split across chunks (encoded %s)', async encoded => {
    const token = randomBytes(32).toString('hex');
    const reflected = encoded ? Buffer.from(`x-access-token:${token}`).toString('base64') : token;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(reflected.slice(0, 10)));
        controller.enqueue(Buffer.from(reflected.slice(10)));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': advertisement } })));
    const response = await fetchGitRead(request(), target(), token);
    await expect(response.text()).rejects.toThrow('Git upstream stream rejected');
  });
  it('sanitizes transport exceptions and invalid content types', async () => {
    const token = randomBytes(32).toString('hex');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(token)));
    expect(await (await fetchGitRead(request(), target(), token)).text()).not.toContain(token);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(token, { headers: { 'Content-Type': token } })));
    expect((await fetchGitRead(request(), target(), token)).status).toBe(502);
  });
});
