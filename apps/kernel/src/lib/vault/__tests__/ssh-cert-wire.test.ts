import { describe, expect, it } from 'vitest';
import { generateKeypair } from '@imajin/auth';
import { encodeSshUserCert, parseSshPublicKey, sshString } from '../ssh-cert-wire';
import { inspectCertificate } from './ssh-cert-inspect';

const ca = generateKeypair();
const client = generateKeypair();
const publicWire = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.from(client.publicKey, 'hex'))]);
const line = `ssh-ed25519 ${publicWire.toString('base64')}`;
describe('OpenSSH Ed25519 wire format', () => {
  it('parses exactly a public Ed25519 key, with optional safe comment', () => {
    expect(parseSshPublicKey(line)?.toString('hex')).toBe(client.publicKey);
    expect(parseSshPublicKey(`${line} throwaway`)?.toString('hex')).toBe(client.publicKey);
  });
  it.each([
    null, 42, '', 'a'.repeat(1025), 'ssh-ed25519 !!!!', 'ssh-rsa AAAA', `${line}\nsecond-key`,
    `ssh-ed25519 ${publicWire.subarray(0, 50).toString('base64')}`,
    `ssh-ed25519 ${Buffer.concat([publicWire, Buffer.alloc(1)]).toString('base64')}`,
    `ssh-ed25519 ${Buffer.concat([sshString('ssh-invalid'), sshString(Buffer.alloc(32))]).toString('base64')}`,
  ])('rejects malformed, multiline or foreign keys (case %#)', value => {
    expect(parseSshPublicKey(value)).toBeNull();
  });
  it.each([0, 15])('rejects malformed SSH string lengths at offset %i', offset => {
    const bad = Buffer.from(publicWire);
    bad.writeUInt32BE(99, offset);
    expect(parseSshPublicKey(`ssh-ed25519 ${bad.toString('base64')}`)).toBeNull();
  });
  it('encodes the entire unsigned 64-bit serial and interoperable restrictions', () => {
    const certificate = encodeSshUserCert({
      publicKey: Buffer.from(client.publicKey, 'hex'), caPublicKey: ca.publicKey, caSeed: ca.privateKey,
      principal: 'deploy', forceCommand: '/bin/true', serial: '18446744073709551615',
      keyId: 'job-test', validAfter: 1, validBefore: 601,
    });
    expect(inspectCertificate(certificate)).toMatchObject({
      serial: '18446744073709551615', userType: 1, principal: 'deploy', forceCommand: '/bin/true', extensions: '',
    });
  });
  it('fails closed on invalid or mismatched CA material without exposing it', () => {
    const input = { publicKey: Buffer.from(client.publicKey, 'hex'), caPublicKey: client.publicKey,
      caSeed: ca.privateKey, principal: 'deploy', forceCommand: '/bin/true',
      serial: '1', keyId: 'job-test', validAfter: 1, validBefore: 601 };
    expect(() => encodeSshUserCert(input)).toThrow('Signer mismatch');
    expect(() => encodeSshUserCert({ ...input, caSeed: 'invalid' })).toThrow('Invalid signing seed');
  });
});
