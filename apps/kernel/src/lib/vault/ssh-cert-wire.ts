import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';

export const SSH_CERT_ALGORITHM = 'ssh-ed25519-cert-v01@openssh.com';
const SSH_KEY_ALGORITHM = 'ssh-ed25519';

export function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function uint64(value: bigint) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(value);
  return result;
}

/** Accept exactly one canonical raw Ed25519 public key, never a private key/cert. */
export function parseSshPublicKey(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(value);
  if (!match) return null;
  const wire = Buffer.from(match[1], 'base64');
  if (wire.length !== 51 || wire.toString('base64') !== match[1]
    || wire.readUInt32BE(0) !== 11 || wire.subarray(4, 15).toString() !== SSH_KEY_ALGORITHM
    || wire.readUInt32BE(15) !== 32) return null;
  return wire.subarray(19);
}

/** No shell, temporary private-key file, configurable options, or default extensions. */
export function encodeSshUserCert(input: {
  publicKey: Buffer; caPublicKey: string; caSeed: string; principal: string;
  forceCommand: string; serial: string; keyId: string; validAfter: number; validBefore: number;
}): string {
  if (!/^[a-f0-9]{64}$/i.test(input.caSeed)) throw new Error('Invalid signing seed');
  const seed = Buffer.from(input.caSeed, 'hex');
  try {
    const key = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der', type: 'pkcs8',
    });
    const publicBytes = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    if (publicBytes.toString('hex') !== input.caPublicKey) throw new Error('Signer mismatch');
    const type = Buffer.alloc(4);
    type.writeUInt32BE(1); // OpenSSH USER certificate, never HOST.
    const unsigned = Buffer.concat([
      sshString(SSH_CERT_ALGORITHM), sshString(randomBytes(32)), sshString(input.publicKey),
      uint64(BigInt(input.serial)), type, sshString(input.keyId),
      sshString(sshString(input.principal)), uint64(BigInt(input.validAfter)), uint64(BigInt(input.validBefore)),
      sshString(Buffer.concat([sshString('force-command'), sshString(sshString(input.forceCommand))])),
      sshString(''), // No permit-X11/agent/port-forwarding, permit-pty, or user-rc.
      sshString(''),
      sshString(Buffer.concat([sshString(SSH_KEY_ALGORITHM), sshString(publicBytes)])),
    ]);
    const signature = sshString(Buffer.concat([sshString(SSH_KEY_ALGORITHM), sshString(sign(null, unsigned, key))]));
    return `${SSH_CERT_ALGORITHM} ${Buffer.concat([unsigned, signature]).toString('base64')}`;
  } finally {
    seed.fill(0);
  }
}
