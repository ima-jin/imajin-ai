import { describe, it, expect } from 'vitest';
import { redactLoopJson, redactLoopText } from '../output-redaction';
import { isBoundedLoopJson, isLoopOutput } from '../output-validation';

describe('loop output redaction', () => {
  it.each([
    'Bearer bearer-secret',
    'Basic dXNlcjpwYXNzd29yZA==',
    'sk_live_stripecredential',
    'sk_test_stripecredential',
    'AIza01234567890123456789012345678901234',
    'glpat-gitlabcredential',
    'eyJheader.eyJpayload.signature',
    'sk-provider-secret-value',
    'ghp_githubsecretvalue',
    'github_pat_githubsecretvalue',
    'xoxb-slacksecretvalue',
    'AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----',
    'api_key=generic-secret',
    'access_token="generic-secret"',
    'password:generic-secret',
    'postgres://user:password@host/db',
  ])('redacts credential-shaped free text %#', value => {
    expect(redactLoopText(value)).toContain('[REDACTED]');
    expect(redactLoopText(value)).not.toBe(value);
  });

  it('redacts sensitive nested field names while retaining unknown JSON structures', () => {
    const raw = {
      a: [{ Authorization: 'auth', api_key: 'key', PRIVATE_KEY: 'pem', password: 'pw', refreshToken: 'token', connectionString: 'dsn' }],
      unknown: { enabled: true, count: 1, nothing: null, values: [1, 2] },
    };
    expect(redactLoopJson(raw)).toEqual({
      a: [{ Authorization: '[REDACTED]', api_key: '[REDACTED]', PRIVATE_KEY: '[REDACTED]', password: '[REDACTED]', refreshToken: '[REDACTED]', connectionString: '[REDACTED]' }],
      unknown: raw.unknown,
    });
    expect(raw.a[0].password).toBe('pw');
  });

  it('retains ordinary text and primitives', () => {
    expect(redactLoopJson({ kind: 'text', text: 'ordinary text', values: [false, 1, null] }))
      .toEqual({ kind: 'text', text: 'ordinary text', values: [false, 1, null] });
  });

  it.each([
    'password="two secret words"',
    "secret='two secret words'",
    'api_key="two \\"escaped\\" secret words"',
    'password="unterminated secret words',
    'password="one" then token="two secret words"',
    '{"password": "two secret words"}',
  ])('redacts entire quoted assignments %#', text => {
    const redacted = redactLoopText(text);
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('secret words');
    expect(redacted).not.toContain('escaped');
  });

  it('retains quoted noncredential assignments', () => {
    expect(redactLoopText('role="two ordinary words"')).toBe('role="two ordinary words"');
  });

  it('redacts multiple and partial PEM blocks without recursion', () => {
    const block = '-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----';
    expect(redactLoopText(`${block} ${block} trailing`)).toBe('[REDACTED] [REDACTED] trailing');
    expect(redactLoopText('prefix -----BEGIN PRIVATE KEY-----remaining secret')).toBe('prefix [REDACTED]');
    expect(redactLoopText('-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY')).toBe('[REDACTED]');
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), () => null])('rejects non-JSON values %#', raw => {
    expect(isBoundedLoopJson(raw)).toBe(false);
  });

  it('rejects cyclic JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.child = cyclic;
    expect(isBoundedLoopJson(cyclic)).toBe(false);
  });

  it('accepts arbitrary JSON-valued args/results/details but not undefined', () => {
    expect(isLoopOutput({ kind: 'tool_call', callId: '1', name: 'tool', args: null })).toBe(true);
    expect(isLoopOutput({ kind: 'tool_result', callId: '1', result: ['x', false, 1, null] })).toBe(true);
    expect(isLoopOutput({ kind: 'approval_request', approvalId: 'a', action: 'go', details: undefined })).toBe(false);
  });
});
