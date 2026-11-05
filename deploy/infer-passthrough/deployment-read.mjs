import {
  closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createDeliveryRequest, HEADER, openDeliveryResponse, PURPOSE, REPOSITORY,
  signingKey, signingPublicKey,
} from './deployment-read-protocol.mjs';

const DIRECTORY = '/etc/imajin';
const TARGET = join(DIRECTORY, 'infer-passthrough-github-token');
const CONFIG = join(DIRECTORY, 'infer-passthrough-deployment-read.json');
const IDENTITY = join(DIRECTORY, 'infer-passthrough-identity');

export function trustedPath(path) {
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('Untrusted delivery path');
    if (dirname(current) === current) break;
  }
}

function removeIfPresent(path) {
  try { unlinkSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Delivery cleanup unavailable');
  }
}

function restrictedRead(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o777) !== 0o600
      || info.nlink !== 1 || info.size > 65536) throw new Error('Untrusted credential storage');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function replace(target, value) {
  const temporary = `${target}.${randomUUID()}.pending`;
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchownSync(fd, 0, 0);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    const directory = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeIfPresent(temporary);
  }
}

/** On write/ack failure restore the previous bytes; neither backup nor diagnostics hold plaintext. */
export async function installDeploymentRead(value, acknowledge, target = TARGET) {
  trustedPath(dirname(target));
  let previous;
  try { previous = restrictedRead(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const bytes = Buffer.from(value);
  try {
    replace(target, bytes);
    await acknowledge();
  } catch {
    if (previous) replace(target, previous);
    else removeIfPresent(target);
    throw new Error('Deployment installation unavailable');
  } finally {
    bytes.fill(0);
    previous?.fill(0);
  }
}

export async function requestDeploymentRead(config, key, method, path, body = '', transport = fetch) {
  const origin = new URL(config.kernelOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== config.kernelOrigin || origin.username || origin.password) {
    throw new Error('Invalid kernel origin');
  }
  const request = createDeliveryRequest(method, path, body, config, key);
  const response = await transport(`${origin.origin}${path}`, {
    method, body: body || undefined, headers: { [HEADER]: request.header, 'Content-Type': 'application/json' },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Deployment authorization unavailable');
  // Bound the response before parsing: upstream diagnostics never escape.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty delivery response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 196608) throw new Error('Oversized delivery response');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return openDeliveryResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')), request, config.kernelPublicKey);
}

/** No caller-selected paths, commands, grant IDs, credential values or fallback. */
export async function deliverDeploymentRead() {
  if (process.geteuid?.() !== 0) throw new Error('Root delivery service required');
  trustedPath(CONFIG);
  trustedPath(IDENTITY);
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const seed = restrictedRead(IDENTITY);
  let key;
  try { key = signingKey(seed.toString('utf8').trim()); } finally { seed.fill(0); }
  const publicKey = signingPublicKey(key);
  if (config.repository !== REPOSITORY || config.recipientDid !== `did:imajin:${publicKey.slice(0, 16)}`
    || typeof config.ownerDid !== 'string' || !config.ownerDid.startsWith('did:')) throw new Error('Invalid recipient policy');
  const api = (method, path, body) => requestDeploymentRead(config, key, method, path, body);
  const { grants } = await api('GET', `/api/vault/delegation/grants?purpose=${encodeURIComponent(PURPOSE)}`);
  // Explicit rotation means only one active import is authorized at a time.
  if (!Array.isArray(grants) || grants.length !== 1 || !/^vdg_[A-Za-z0-9_-]+$/.test(grants[0].grantId)) {
    throw new Error('Unique deployment authority required');
  }
  const grantId = grants[0].grantId;
  const path = `/api/vault/delegation/grants/${grantId}`;
  const result = await api('POST', `${path}/fetch`);
  if (result.grantId !== grantId || result.repository !== REPOSITORY || result.purpose !== PURPOSE
    || result.recipientDid !== config.recipientDid || Date.parse(result.expiresAt) <= Date.now()
    || !Number.isFinite(Date.parse(result.expiresAt))
    || !Number.isFinite(Date.parse(result.fetchedAt))
    || typeof result.value !== 'string' || !result.value || Buffer.byteLength(result.value) > 65536
    || /[\r\n\0]/.test(result.value)) throw new Error('Invalid deployment receipt');
  await installDeploymentRead(result.value, async () => {
    const ack = await api('POST', `${path}/ack`, JSON.stringify({ outcome: 'used', fetchedAt: result.fetchedAt }));
    if (ack.ok !== true) throw new Error('Acknowledgment unavailable');
  });
  return result.value;
}

export async function deliveryMain() {
  try {
    if (process.argv.length !== 2) throw new Error('No delivery arguments permitted');
    await deliverDeploymentRead();
    return 0;
  } catch {
    console.error('Gateway deployment credential delivery unavailable');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  process.exitCode = await deliveryMain();
}
