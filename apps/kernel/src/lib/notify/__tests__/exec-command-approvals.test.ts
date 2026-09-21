/**
 * Tests for the exec.command approval kind contract (#2221): the detail
 * schema, the allow-once/deny-only decision-mode gate (allow-always must
 * never be reachable), and the expiry check.
 */
import { describe, it, expect } from 'vitest';
import {
  EXEC_COMMAND_KIND,
  EXEC_COMMAND_SOURCE,
  validateExecCommandDetail,
  asExecCommandDetail,
  isExecCommandExpired,
  validateExecCommandDecisionMode,
} from '../exec-command-approvals';

function validDetail(overrides: Record<string, unknown> = {}) {
  return {
    command: 'systemctl restart openclaw-gateway',
    host: 'gateway-01',
    cwd: '/opt/openclaw',
    agentId: 'agent_123',
    sessionKey: 'session_abc',
    requestedBy: 'did:imajin:jin-agent',
    approvalId: 'oc_approval_1',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('EXEC_COMMAND_SOURCE / EXEC_COMMAND_KIND', () => {
  it('is namespaced under the open vocabulary convention (#2152: "<source>:<subkind>", hyphenated, no dots)', () => {
    expect(EXEC_COMMAND_SOURCE).toBe('gateway-exec');
    expect(EXEC_COMMAND_KIND).toBe('gateway-exec:command');
    expect(EXEC_COMMAND_KIND.startsWith(`${EXEC_COMMAND_SOURCE}:`)).toBe(true);
  });
});

describe('validateExecCommandDetail', () => {
  it('accepts a well-formed detail object', () => {
    const detail = validDetail();
    const result = validateExecCommandDetail(detail);
    expect(result).toEqual({ ok: true, detail });
  });

  it('rejects a null detail', () => {
    const result = validateExecCommandDetail(null);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/detail is required/) });
  });

  it.each([
    'command',
    'host',
    'cwd',
    'agentId',
    'sessionKey',
    'requestedBy',
    'approvalId',
    'expiresAt',
  ])('rejects a missing %s', (field) => {
    const detail = validDetail({ [field]: undefined });
    const result = validateExecCommandDetail(detail);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(new RegExp(`detail\\.${field}`));
  });

  it.each(['command', 'host', 'cwd', 'agentId', 'sessionKey', 'requestedBy', 'approvalId'])(
    'rejects an empty-string %s',
    (field) => {
      const result = validateExecCommandDetail(validDetail({ [field]: '' }));
      expect(result.ok).toBe(false);
    },
  );

  it('rejects requestedBy that is not a DID', () => {
    const result = validateExecCommandDetail(validDetail({ requestedBy: 'jin-agent' }));
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/must be a DID/) });
  });

  it('rejects an unparseable expiresAt', () => {
    const result = validateExecCommandDetail(validDetail({ expiresAt: 'not-a-date' }));
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/ISO 8601/) });
  });

  it('never truncates or summarises the command — an arbitrarily long verbatim command round-trips exactly', () => {
    const longCommand = `echo start && ${'x'.repeat(4000)} && echo done`;
    const result = validateExecCommandDetail(validDetail({ command: longCommand }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.detail.command).toBe(longCommand);
  });
});

describe('asExecCommandDetail', () => {
  it('returns the parsed detail for a well-formed row', () => {
    const detail = validDetail();
    expect(asExecCommandDetail(detail)).toEqual(detail);
  });

  it('returns null for a malformed or missing detail', () => {
    expect(asExecCommandDetail(null)).toBeNull();
    expect(asExecCommandDetail({ command: 'x' })).toBeNull();
  });
});

describe('isExecCommandExpired', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');

  it('is false while expiresAt is still in the future', () => {
    expect(isExecCommandExpired({ expiresAt: '2026-09-20T12:05:00.000Z' }, now)).toBe(false);
  });

  it('is true once expiresAt has passed', () => {
    expect(isExecCommandExpired({ expiresAt: '2026-09-20T11:59:00.000Z' }, now)).toBe(true);
  });

  it('is true exactly at the expiry instant (inclusive)', () => {
    expect(isExecCommandExpired({ expiresAt: now.toISOString() }, now)).toBe(true);
  });

  it('is false for an unparseable expiresAt (fail open on shape, the kernel already rejected this at ingest)', () => {
    expect(isExecCommandExpired({ expiresAt: 'not-a-date' }, now)).toBe(false);
  });
});

describe('validateExecCommandDecisionMode — allow-once | deny only', () => {
  it('accepts approve with no mode', () => {
    expect(validateExecCommandDecisionMode('approve', undefined)).toEqual({ ok: true });
  });

  it('accepts approve with mode allow-once', () => {
    expect(validateExecCommandDecisionMode('approve', 'allow-once')).toEqual({ ok: true });
  });

  it('accepts reject with no mode', () => {
    expect(validateExecCommandDecisionMode('reject', undefined)).toEqual({ ok: true });
  });

  it('accepts reject with mode deny', () => {
    expect(validateExecCommandDecisionMode('reject', 'deny')).toEqual({ ok: true });
  });

  it('always accepts withdrawn regardless of mode (orthogonal generic revoke)', () => {
    expect(validateExecCommandDecisionMode('withdrawn', 'allow-always')).toEqual({ ok: true });
  });

  it('rejects approve with mode allow-always — the exact loophole this gate exists to close', () => {
    const result = validateExecCommandDecisionMode('approve', 'allow-always');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/allow-always/);
    expect(result.error).toMatch(/allow-once/);
  });

  it('rejects reject paired with mode allow-once (mismatched pairing)', () => {
    const result = validateExecCommandDecisionMode('reject', 'allow-once');
    expect(result.ok).toBe(false);
  });

  it('rejects an arbitrary unknown mode value', () => {
    const result = validateExecCommandDecisionMode('approve', 'grant-forever');
    expect(result.ok).toBe(false);
  });
});
