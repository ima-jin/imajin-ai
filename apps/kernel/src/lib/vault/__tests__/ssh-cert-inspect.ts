import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
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
