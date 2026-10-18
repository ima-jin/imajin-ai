import { describe, expect, it } from 'vitest';
import { validateMailDomain, validateSenderConfig } from '../validation';
import { isDomainMailReady } from '../readiness';
import { MAIL_PURPOSES, DEFAULT_SENDERS, type SenderConfig } from '../types';

const config: SenderConfig = {
  ownerDid: 'did:imajin:owner', purpose: 'signin', appDid: '', domain: 'Example.COM',
  localPart: 'sign.in', displayName: 'Example Signin', replyTo: null,
};

describe('sender validation', () => {
  it('normalizes DNS case and preserves the fixed vocabulary', () => {
    expect(validateSenderConfig(config)).toEqual({ ...config, domain: 'example.com' });
    expect(Object.keys(DEFAULT_SENDERS)).toEqual([...MAIL_PURPOSES]);
    for (const purpose of MAIL_PURPOSES) expect(validateSenderConfig({ ...config, purpose }).purpose).toBe(purpose);
  });
  it.each(['https://example.com', 'example.com/path', 'example.com:25', 'user@example.com', 'example.com.', '-x.com', 'x-.com',
    'x..com', 'localhost', '127.0.0.1', 'x.1', 'x.com\r\nBcc: a@b.com', ' x.com', 'x.com ', 'é.com', 'a'.repeat(64) + '.com',
    'a.'.repeat(126) + 'com'])('rejects non-domain value %s', value => {
    expect(() => validateMailDomain(value)).toThrow();
  });
  it.each(['.hello', 'hello.', 'a..b', 'x y', 'a@b', 'a\r\nbcc', 'a'.repeat(65), ''])('rejects localpart %s', value => {
    expect(() => validateSenderConfig({ ...config, localPart: value })).toThrow();
  });
  it.each(['', ' Bad', 'Bad ', 'X <x>', '"X"', 'X\\Y', 'A,B', 'A;B', 'A\nB', 'A\u0000B', 'A\u200bB', 'a'.repeat(101)])('rejects display header %s', value => {
    expect(() => validateSenderConfig({ ...config, displayName: value })).toThrow();
  });
  it.each(['a@@b.com', 'X <a@b.com>', 'a@b.com\nBcc:x@y.com', '', 'a@localhost', 'a'.repeat(255)])('rejects reply header %s', value => {
    expect(() => validateSenderConfig({ ...config, replyTo: value })).toThrow();
  });
  it('accepts a simple reply-to, app identity, and subdomain', () => {
    expect(validateSenderConfig({ ...config, appDid: 'did:imajin:app', domain: 'mail.example.co.uk', replyTo: 'team+help@example.com' }).replyTo)
      .toBe('team+help@example.com');
  });
  it('rejects unrecognized purposes and malformed identities', () => {
    expect(() => validateSenderConfig({ ...config, purpose: 'custom' as never })).toThrow('purpose');
    expect(() => validateSenderConfig({ ...config, ownerDid: 'owner' })).toThrow('DID');
    expect(() => validateSenderConfig({ ...config, appDid: 'app\r\n' })).toThrow('DID');
  });
  it('never authorizes configured or unconfigured domains in production', async () => {
    await expect(isDomainMailReady(config.ownerDid, config.domain)).resolves.toBe(false);
    await expect(isDomainMailReady(config.ownerDid, 'imajin.ai')).resolves.toBe(false);
  });
});
