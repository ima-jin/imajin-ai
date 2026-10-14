import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computeKeyKid } from './key-rotation';

export type KernelWebhookErrorCode =
  | 'INVALID_REQUEST' | 'STALE' | 'FUTURE' | 'SIGNATURE_INVALID'
  | 'UNKNOWN_KEY' | 'TRUST' | 'DISCOVERY' | 'STORE' | 'REPLAY' | 'INVALID_BODY';

export class KernelWebhookError extends Error {
  constructor(public readonly code: KernelWebhookErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KernelWebhookError';
  }
}

export interface KernelWebhookKey {
  kid: string;
  publicKey: string;
  algorithm: 'Ed25519';
  validFrom: string;
  validUntil?: string;
}

/** Shared stores must serialize the entire load/reconcile/save transaction per namespace. */
export interface KernelWebhookPinStore {
  load(namespace: string): Promise<unknown>;
  save(namespace: string, keys: readonly KernelWebhookKey[]): Promise<void>;
  withLock<T>(namespace: string, operation: () => Promise<T>): Promise<T>;
}

export interface KernelWebhookNonceStore {
  /** Atomically insert if absent; never evict a live nonce. Expiry is milliseconds since epoch. */
  consume(key: string, expiresAt: number): boolean | Promise<boolean>;
}

export interface VerifyKernelWebhookOptions {
  /** Kernel auth base URL, including /auth. Defaults to AUTH_SERVICE_URL. */
  authServiceUrl?: string;
  /** Unsafe for public networks. Defaults false; loopback HTTP is always allowed for development. */
  allowInsecureHttp?: boolean;
  pinStore?: KernelWebhookPinStore;
  nonceStore?: KernelWebhookNonceStore;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds since epoch. */
  clock?: () => number;
  maxAgeSeconds?: number;
  futureToleranceSeconds?: number;
  fetchTimeoutMs?: number;
}

const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function canonicalKernelWebhookPayload(input: {
  timestamp: string | number;
  nonce: string;
  method: string;
  url: string | URL;
  rawBody: string | Uint8Array;
}): string {
  const url = new URL(input.url);
  return `imajin-webhook-v1\n${input.timestamp}\n${input.nonce}\n${input.method.toUpperCase()}\n${url.pathname}${url.search}\n${digest(input.rawBody)}`;
}

/** Durable public keys only. Use a persistent volume; a stale lock fails closed, never re-pins. */
export function createFileKernelWebhookPinStore(
  directory = join(process.cwd(), 'data', 'kernel-webhook-pins'),
): KernelWebhookPinStore {
  const root = resolve(directory);
  const filename = (namespace: string): string => join(root, `${digest(namespace)}.json`);
  return {
    async load(namespace) {
      try {
        return JSON.parse(await readFile(filename(namespace), 'utf8')) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async save(namespace, keys) {
      const temporary = `${filename(namespace)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(keys), { flag: 'wx', mode: 0o600 });
        await rename(temporary, filename(namespace));
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
    async withLock(namespace, operation) {
      await mkdir(root, { recursive: true });
      const lockPath = `${filename(namespace)}.lock`;
      const deadline = Date.now() + 10_000;
      let lock;
      while (!lock) {
        try {
          lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
          await new Promise((done) => setTimeout(done, 25));
        }
      }
      try {
        return await operation();
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    },
  };
}

/** Single-process only. A full live store rejects new deliveries rather than evicting replay evidence. */
export function createMemoryKernelWebhookNonceStore(options: {
  maxEntries?: number;
  clock?: () => number;
} = {}): KernelWebhookNonceStore {
  const entries = new Map<string, number>();
  const maximum = options.maxEntries ?? 100_000;
  const clock = options.clock ?? Date.now;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('Invalid nonce capacity');
  return {
    consume(key, expiresAt) {
      const now = clock();
      for (const [nonce, expiry] of entries) if (expiry <= now) entries.delete(nonce);
      if (entries.has(key)) return false;
      if (entries.size >= maximum) throw new Error('Nonce store capacity exhausted');
      entries.set(key, expiresAt);
      return true;
    },
  };
}

const defaultNonceStore = createMemoryKernelWebhookNonceStore();
// Resolve cwd at use, not package import (applications may change cwd during startup).
let defaultPinStore: KernelWebhookPinStore | undefined;

function fail(code: KernelWebhookErrorCode, message: string): never {
  throw new KernelWebhookError(code, message);
}
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function parseKeys(value: unknown, code: 'TRUST' | 'DISCOVERY'): KernelWebhookKey[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) fail(code, 'Invalid kernel key set');
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(code, 'Invalid kernel key');
    const key = raw as Record<string, unknown>;
    if (typeof key.kid !== 'string' || typeof key.publicKey !== 'string'
      || !/^[0-9a-f]{64}$/.test(key.publicKey) || key.algorithm !== 'Ed25519'
      || computeKeyKid(key.publicKey) !== key.kid || seen.has(key.kid)
      || !isIsoTimestamp(key.validFrom)
      || (key.validUntil !== undefined && (!isIsoTimestamp(key.validUntil)
        || Date.parse(key.validUntil) <= Date.parse(key.validFrom)))) {
      fail(code, 'Malformed or duplicate kernel key');
    }
    seen.add(key.kid);
    return {
      kid: key.kid, publicKey: key.publicKey, algorithm: 'Ed25519',
      validFrom: key.validFrom,
      ...(key.validUntil === undefined ? {} : { validUntil: key.validUntil as string }),
    };
  });
}

function active(key: KernelWebhookKey, now: number): boolean {
  return Date.parse(key.validFrom) <= now && (key.validUntil === undefined || Date.parse(key.validUntil) > now);
}

async function discover(url: string, options: VerifyKernelWebhookOptions): Promise<KernelWebhookKey[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race bounds even a custom fetch implementation that ignores AbortSignal.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new KernelWebhookError('DISCOVERY', 'Kernel signing-key discovery timed out'));
    }, options.fetchTimeoutMs ?? 5_000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await (options.fetch ?? globalThis.fetch)(`${url}/.well-known/kernel-signing-key`, {
        signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) fail('DISCOVERY', 'Kernel signing-key discovery failed');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('DISCOVERY', 'Invalid kernel document');
      const document = body as Record<string, unknown>;
      const keys = parseKeys(document.keys, 'DISCOVERY');
      if (typeof document.current !== 'string' || !keys.some((key) => key.kid === document.current)) {
        fail('DISCOVERY', 'Missing current kernel key');
      }
      return keys;
    })()]);
  } catch (error) {
    if (error instanceof KernelWebhookError) throw error;
    throw new KernelWebhookError('DISCOVERY', 'Cannot fetch kernel signing keys', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function configuration(options: VerifyKernelWebhookOptions) {
  const now = (options.clock ?? Date.now)();
  const maxAge = options.maxAgeSeconds ?? 300;
  const future = options.futureToleranceSeconds ?? 300;
  if (!Number.isFinite(now) || !Number.isSafeInteger(maxAge) || maxAge < 1
    || !Number.isSafeInteger(future) || future < 0
    || (options.fetchTimeoutMs !== undefined && (!Number.isSafeInteger(options.fetchTimeoutMs) || options.fetchTimeoutMs < 1))) {
    fail('INVALID_REQUEST', 'Invalid webhook verifier configuration');
  }
  let base: URL;
  try {
    base = new URL(options.authServiceUrl ?? process.env.AUTH_SERVICE_URL ?? '');
  } catch {
    fail('INVALID_REQUEST', 'Missing or invalid auth service URL');
  }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    fail('INVALID_REQUEST', 'Invalid auth service URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol === 'http:' && !loopback && options.allowInsecureHttp !== true) {
    fail('INVALID_REQUEST', 'Remote kernel discovery requires HTTPS');
  }
  return { now, maxAge, future, namespace: base.href.replace(/\/+$/, '') };
}

/** Authenticate raw bytes before parsing JSON. Consumes the request body once; never trusts legacy shared-secret headers. */
export async function verifyKernelWebhook<T = unknown>(
  request: Request,
  options: VerifyKernelWebhookOptions = {},
): Promise<T> {
  try {
    const { now, maxAge, future, namespace } = configuration(options);
    const timestamp = request.headers.get('x-kernel-timestamp') ?? '';
    const nonce = request.headers.get('x-kernel-nonce') ?? '';
    const kid = request.headers.get('x-kernel-kid') ?? '';
    const signature = request.headers.get('x-kernel-signature') ?? '';
    if (!/^(0|[1-9][0-9]{0,12})$/.test(timestamp)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
      || !/^auth-[0-9a-f]{16}$/.test(kid) || !/^[0-9a-f]{128}$/i.test(signature)) {
      fail('INVALID_REQUEST', 'Missing or malformed kernel webhook signature headers');
    }
    const signedAt = Number(timestamp) * 1_000;
    if (now - signedAt >= maxAge * 1_000) fail('STALE', 'Kernel webhook timestamp expired');
    if (signedAt - now > future * 1_000) fail('FUTURE', 'Kernel webhook timestamp is in the future');
    const rawBody = new Uint8Array(await request.arrayBuffer());
    const store = options.pinStore ?? (defaultPinStore ??= createFileKernelWebhookPinStore());
    const published = await store.withLock(namespace, async () => {
      const stored = await store.load(namespace);
      const pinned = stored === null ? [] : parseKeys(stored, 'TRUST');
      const keys = await discover(namespace, options);
      const currentTime = (options.clock ?? Date.now)();
      const live = keys.filter((key) => active(key, currentTime));
      if (live.length === 0) fail('TRUST', 'Kernel has no active signing keys');
      if (pinned.length && !live.some((key) => pinned.some(
        (pin) => pin.kid === key.kid && pin.publicKey === key.publicKey,
      ))) fail('TRUST', 'Kernel key set does not overlap pinned public keys');
      await store.save(namespace, live);
      return live;
    });
    const key = published.find((entry) => entry.kid === kid);
    if (!key) fail('UNKNOWN_KEY', 'Webhook key is not currently published and active');
    // SPKI prefix for a raw 32-byte Ed25519 public key (RFC 8410).
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key.publicKey, 'hex')]),
      format: 'der', type: 'spki',
    });
    const payload = canonicalKernelWebhookPayload({
      timestamp, nonce, method: request.method, url: request.url, rawBody,
    });
    if (!verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'hex'))) {
      fail('SIGNATURE_INVALID', 'Kernel webhook signature does not verify');
    }
    // Recheck time after I/O; discovery must not extend freshness or key validity.
    const verifiedAt = (options.clock ?? Date.now)();
    if (verifiedAt - signedAt >= maxAge * 1_000) fail('STALE', 'Kernel webhook expired during verification');
    if (!active(key, verifiedAt)) fail('UNKNOWN_KEY', 'Kernel webhook key expired during verification');
    const consumed = await (options.nonceStore ?? defaultNonceStore).consume(
      `${namespace}\n${nonce.toLowerCase()}`, signedAt + maxAge * 1_000,
    );
    if (consumed !== true) {
      if (consumed === false) fail('REPLAY', 'Kernel webhook nonce already consumed');
      fail('STORE', 'Invalid atomic nonce-store result');
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as T;
    } catch (error) {
      throw new KernelWebhookError('INVALID_BODY', 'Kernel webhook body is not JSON', { cause: error });
    }
  } catch (error) {
    if (error instanceof KernelWebhookError) throw error;
    throw new KernelWebhookError('STORE', 'Kernel webhook verification failed closed', { cause: error });
  }
}
