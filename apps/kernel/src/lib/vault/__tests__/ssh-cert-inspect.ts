import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { expect } from 'vitest';

/** Independent test decoder, not the production encoder. Only public certs touch disk. */
export function inspectCertificate(certificate: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-cert-test-'));
  const file = join(dir, 'key-cert.pub');
  writeFileSync(file, certificate + '\n');
  const listing = execFileSync('ssh-keygen', ['-L', '-f', file], { encoding: 'utf8' });
  expect(listing).toContain('ssh-ed25519-cert-v01@openssh.com user certificate');
  expect(listing).toContain('Extensions: (none)');
  const wire = Buffer.from(certificate.split(' ')[1], 'base64');
  let offset = 0;
  const string = () => { const length = wire.readUInt32BE(offset); offset += 4;
    const result = wire.subarray(offset, offset + length); offset += length; return result; };
  const uint64 = () => { const value = wire.readBigUInt64BE(offset); offset += 8; return value; };
  expect(string().toString()).toBe('ssh-ed25519-cert-v01@openssh.com');
  string(); // nonce
  const publicKey = string();
  const serial = uint64().toString();
  const userType = wire.readUInt32BE(offset); offset += 4;
  const keyId = string().toString();
  const principals = string();
  expect(principals.readUInt32BE(0)).toBe(principals.length - 4); // exactly one
  const principal = principals.subarray(4).toString();
  const validAfter = Number(uint64());
  const validBefore = Number(uint64());
  const options = string();
  const optionNameLength = options.readUInt32BE(0);
  expect(options.subarray(4, 4 + optionNameLength).toString()).toBe('force-command');
  const dataStart = 8 + optionNameLength;
  expect(options.readUInt32BE(dataStart)).toBe(options.length - dataStart - 4);
  const forceCommand = options.subarray(dataStart + 4).toString();
  const extensions = string().toString();
  expect(string()).toHaveLength(0); // reserved
  const caWire = string();
  const unsigned = wire.subarray(0, offset);
  const signature = string().subarray(19); // string('ssh-ed25519'), string(64-byte signature)
  expect(offset).toBe(wire.length);
  const ca = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), caWire.subarray(19),
  ]), format: 'der', type: 'spki' });
  const signatureValid = verify(null, unsigned, ca, signature);
  expect(signatureValid).toBe(true);
  return { serial, keyId, userType, publicKey, principal, validAfter, validBefore, forceCommand,
    extensions, caWire, signatureValid };
}

export function acceptsCertificate(cert: ReturnType<typeof inspectCertificate>, ca: string, principal: string, now: number) {
  return cert.signatureValid && cert.caWire.equals(Buffer.from(ca.split(' ')[1], 'base64'))
    && cert.userType === 1 && cert.principal === principal && now >= cert.validAfter && now < cert.validBefore;
}

/** OpenSSH itself checks the CA, certificate principals and validity of an SSHSIG. */
export function openSshAccepts(certificate: string, ca: string, clientSeed: string, principal: string, now: number) {
  const field = (value: string | Buffer) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const namespace = 'vault-cert-test';
  const message = Buffer.from('public interoperability probe');
  const signed = Buffer.concat([Buffer.from('SSHSIG'), field(namespace), field(''), field('sha512'),
    field(createHash('sha512').update(message).digest())]);
  const key = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(clientSeed, 'hex'),
  ]), format: 'der', type: 'pkcs8' });
  const version = Buffer.alloc(4); version.writeUInt32BE(1);
  const signature = Buffer.concat([Buffer.from('SSHSIG'), version,
    field(Buffer.from(certificate.split(' ')[1], 'base64')), field(namespace), field(''), field('sha512'),
    field(Buffer.concat([field('ssh-ed25519'), field(sign(null, signed, key))]))]);
  const dir = mkdtempSync(join(tmpdir(), 'ssh-cert-verify-'));
  const allowed = join(dir, 'allowed-signers');
  const signatureFile = join(dir, 'message.sig');
  writeFileSync(allowed, `deploy cert-authority ${ca}\n`);
  writeFileSync(signatureFile, `-----BEGIN SSH SIGNATURE-----\n${signature.toString('base64')}\n-----END SSH SIGNATURE-----\n`);
  const verifyTime = new Date(now * 1000).toISOString().replaceAll(/[-:TZ]/g, '').slice(0, 14);
  return spawnSync('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', principal, '-n', namespace,
    '-s', signatureFile, '-O', `verify-time=${verifyTime}`], { input: message }).status === 0;
}
