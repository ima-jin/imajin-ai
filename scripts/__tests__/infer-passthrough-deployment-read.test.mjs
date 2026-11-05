import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEADER, PURPOSE, REPOSITORY, sealDeliveryResponse, signingPublicKey, verifyDeliveryRequest,
} from '../../deploy/infer-passthrough/deployment-read-protocol.mjs';

const h = vi.hoisted(() => ({
  files: new Map(), handles: new Map(), trace: [], nextFd: 10, fail: '', unsafe: '',
}));
vi.mock('node:path', async original => {
  const actual = await original();
  return { ...actual, dirname: actual.posix.dirname, join: actual.posix.join };
});
vi.mock('node:fs', async original => {
  const actual = await original();
  const missing = () => Object.assign(new Error('Missing'), { code: 'ENOENT' });
  const fault = operation => {
    h.trace.push(operation);
    if (h.fail === operation) { h.fail = ''; throw new Error('Injected storage failure'); }
  };
  return {
    ...actual,
    lstatSync: path => ({
      uid: path === h.unsafe ? 1000 : 0, mode: 0o700,
      isSymbolicLink: () => path === `${h.unsafe}/symlink`,
    }),
    openSync: (path, flags, mode) => {
      fault('open');
      let file = h.files.get(path);
      const creating = Boolean(flags & actual.constants.O_CREAT);
      if (creating) {
        if (file) throw new Error('Exclusive create failed');
        file = { bytes: Buffer.alloc(0), mode, uid: 0, gid: 0, nlink: 1 };
        h.files.set(path, file);
        h.trace.push(['create', path, mode, flags]);
      } else if (!file && path !== '/etc/imajin') throw missing();
      const fd = h.nextFd++;
      h.handles.set(fd, { path, file });
      return fd;
    },
    fstatSync: fd => {
      const file = h.handles.get(fd).file;
      return { ...file, size: file.bytes.length, isFile: () => !file.symlink };
    },
    readFileSync: (path, encoding) => {
      const file = typeof path === 'number' ? h.handles.get(path).file : h.files.get(path);
      if (!file) throw missing();
      return encoding ? file.bytes.toString(encoding) : Buffer.from(file.bytes);
    },
    writeFileSync: (fd, bytes) => {
      fault('write');
      h.handles.get(fd).file.bytes = Buffer.from(bytes);
    },
    fchownSync: (fd, uid, gid) => {
      h.trace.push(['chown', uid, gid]);
      Object.assign(h.handles.get(fd).file, { uid, gid });
    },
    fchmodSync: (fd, mode) => { h.handles.get(fd).file.mode = mode; },
    closeSync: fd => { h.handles.delete(fd); },
    fsyncSync: () => fault('fsync'),
    renameSync: (from, to) => {
      fault('rename');
      h.files.set(to, h.files.get(from));
      h.files.delete(from);
    },
    unlinkSync: path => { if (!h.files.delete(path)) throw missing(); },
  };
});

import {
  deliverDeploymentRead, deliveryMain, installDeploymentRead, requestDeploymentRead, trustedPath,
} from '../../deploy/infer-passthrough/deployment-read.mjs';

const host = generateKeyPairSync('ed25519').privateKey;
const kernel = generateKeyPairSync('ed25519').privateKey;
const recipientDid = `did:imajin:${signingPublicKey(host).slice(0, 16)}`;
const target = '/etc/imajin/infer-passthrough-github-token';
const fixture = 'test-credential-not-a-token';
const previous = 'test-previous-credential-not-a-token';
const config = {
  kernelOrigin: 'https://kernel.test', kernelPublicKey: signingPublicKey(kernel),
  repository: REPOSITORY, ownerDid: 'did:imajin:owner', recipientDid,
};
const expiresAt = () => new Date(Date.now() + 120_000).toISOString();

function file(value) {
  return { bytes: Buffer.from(value), mode: 0o600, uid: 0, gid: 0, nlink: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.files.clear(); h.handles.clear(); h.trace = []; h.fail = ''; h.unsafe = '';
  vi.stubGlobal('process', { ...process, geteuid: () => 0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.files.set('/etc/imajin/infer-passthrough-deployment-read.json', file(JSON.stringify(config)));
  h.files.set('/etc/imajin/infer-passthrough-identity', file(host.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex')));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function transport(change = value => value) {
  return vi.fn(async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    const claim = verifyDeliveryRequest(options.headers[HEADER], options.method, path, options.body ?? '', config, signingPublicKey(host));
    let value;
    if (options.method === 'GET') value = { grants: [{ grantId: 'vdg_fixture', expiresAt: expiresAt() }] };
    else if (path.endsWith('/ack')) value = { ok: true };
    else value = {
      grantId: 'vdg_fixture', value: fixture, repository: REPOSITORY, purpose: PURPOSE,
      recipientDid, expiresAt: expiresAt(), fetchedAt: new Date().toISOString(),
    };
    return Response.json(sealDeliveryResponse(change(value, path), claim, Date.now() + 30_000, kernel));
  });
}

describe('root gateway deployment-read consumer', () => {
  it('discovers its grant, atomically installs root:root 0600, acknowledges, and retries/rotates', async () => {
    const fetch = transport();
    vi.stubGlobal('fetch', fetch);
    expect(await deliverDeploymentRead()).toBe(fixture);
    expect(h.files.get(target)).toMatchObject({ mode: 0o600, uid: 0, gid: 0 });
    expect(h.files.get(target).bytes.toString()).toBe(fixture);
    expect(h.trace.indexOf('fsync')).toBeLessThan(h.trace.indexOf('rename'));
    expect(h.trace).toContainEqual(['chown', 0, 0]);
    await deliverDeploymentRead();
    const rotated = 'test-rotated-credential-not-a-token';
    vi.stubGlobal('fetch', transport(value => value.value ? { ...value, value: rotated } : value));
    await deliverDeploymentRead();
    expect(h.files.get(target).bytes.toString()).toBe(rotated);
    expect([...h.files.keys()].some(path => path.endsWith('.pending'))).toBe(false);
    expect(fetch.mock.calls[2][0]).toContain('/ack');
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(fixture);
    expect(process.argv.some(value => value.includes(fixture))).toBe(false);
    expect(Object.values(process.env).some(value => value?.includes(fixture))).toBe(false);
    expect(JSON.stringify(console.error.mock.calls)).not.toContain(fixture);
  });

  it.each(['write', 'fsync', 'rename'])('preserves the previous file when %s fails', async operation => {
    h.files.set(target, file(previous));
    h.fail = operation;
    const ack = vi.fn();
    await expect(installDeploymentRead(fixture, ack)).rejects.toThrow();
    expect(h.files.get(target).bytes.toString()).toBe(previous);
    expect(ack).not.toHaveBeenCalled();
    expect([...h.files.keys()].some(path => path.endsWith('.pending'))).toBe(false);
  });

  it('restores previous file on failed acknowledgment and never leaves a failed first delivery', async () => {
    const ack = async () => { throw new Error(fixture); };
    h.files.set(target, file(previous));
    await expect(installDeploymentRead(fixture, ack)).rejects.toThrow('Deployment installation unavailable');
    expect(h.files.get(target).bytes.toString()).toBe(previous);
    h.files.delete(target);
    await expect(installDeploymentRead(fixture, ack)).rejects.toThrow();
    expect(h.files.has(target)).toBe(false);
    expect(h.handles.size).toBe(0);
  });

  it.each([
    { uid: 1000 }, { gid: 1000 }, { mode: 0o644 }, { nlink: 2 }, { symlink: true },
  ])('refuses unsafe preexisting credential %j', async extra => {
    h.files.set(target, { ...file(previous), ...extra });
    await expect(installDeploymentRead(fixture, vi.fn())).rejects.toThrow();
    expect(h.files.get(target).bytes.toString()).toBe(previous);
  });

  it('rejects non-root execution and untrusted ancestors without reading or writing secrets', async () => {
    vi.stubGlobal('process', { ...process, geteuid: () => 1000 });
    await expect(deliverDeploymentRead()).rejects.toThrow('Root');
    h.unsafe = '/etc';
    expect(() => trustedPath(target)).toThrow();
    h.unsafe = '/etc/imajin';
    expect(() => trustedPath('/etc/imajin/symlink')).toThrow();
    expect(h.trace).toEqual([]);
  });

  it.each([
    { repository: 'ima-jin/other' }, { purpose: 'wrong' }, { recipientDid: 'did:imajin:wrong' },
    { expiresAt: new Date(0).toISOString() }, { expiresAt: 'invalid' }, { value: '' },
    { fetchedAt: 'invalid' }, { value: 123 },
    { value: 'not\nallowed' }, { grantId: 'vdg_other' },
  ])('rejects invalid delivery receipt %j before replacing the file', async extra => {
    h.files.set(target, file(previous));
    vi.stubGlobal('fetch', transport(value => value.value ? { ...value, ...extra } : value));
    await expect(deliverDeploymentRead()).rejects.toThrow();
    expect(h.files.get(target).bytes.toString()).toBe(previous);
  });

  it('rejects zero or ambiguous grants without fetching a secret', async () => {
    for (const grants of [[], [{ grantId: 'vdg_one' }, { grantId: 'vdg_two' }], [{ grantId: '../other' }]]) {
      const fetch = transport(() => ({ grants }));
      vi.stubGlobal('fetch', fetch);
      await expect(deliverDeploymentRead()).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses HTTP, redirects, oversized responses and failure bodies', async () => {
    const fetch = vi.fn();
    await expect(requestDeploymentRead({ ...config, kernelOrigin: 'http://kernel.test' }, host, 'GET', '/list', '', fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    for (const response of [new Response(fixture, { status: 403 }), new Response('x'.repeat(196609)), new Response(null)]) {
      fetch.mockResolvedValueOnce(response);
      await expect(requestDeploymentRead(config, host, 'GET', '/list', '', fetch)).rejects.toThrow();
    }
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });

  it('logs only a fixed error even if upstream errors contain the fixture', async () => {
    vi.stubGlobal('process', { ...process, argv: ['node', 'deployment-read.mjs'] });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(fixture)));
    expect(await deliveryMain()).toBe(1);
    expect(console.error).toHaveBeenCalledWith('Gateway deployment credential delivery unavailable');
    expect(JSON.stringify(console.error.mock.calls)).not.toContain(fixture);
  });
});
