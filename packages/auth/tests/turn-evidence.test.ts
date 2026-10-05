import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  TURN_EVIDENCE_ATTESTATION_TYPE,
  TURN_EVIDENCE_CONTEXT_TYPE,
  buildTurnEvidencePayload,
  hashToolIo,
  normalizeHash,
  parseTurnEvidencePayload,
  sha256Hash,
  turnEvidenceSigningFields,
  turnEvidenceSigningMessage,
  type TurnEvidenceFields,
} from '../src/turn-evidence';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '../src/types/attestation';
import { canonicalize } from '../src/sign';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

function fields(overrides: Partial<TurnEvidenceFields> = {}): TurnEvidenceFields {
  return {
    turnEventId: 'turn_evt_123',
    turnOutputHash: `sha256:${HEX_A}`,
    agentDid: 'did:imajin:agent',
    principalDid: 'did:imajin:principal',
    tool: { name: 'web_fetch', provider: 'openclaw' },
    inputHash: `sha256:${HEX_B}`,
    outputHash: `sha256:${HEX_C}`,
    observedAt: '2026-09-04T03:54:12Z',
    seq: 3,
    ...overrides,
  };
}

describe('registration', () => {
  it('registers agent.turn.evidence as an attestation type, once', () => {
    expect(ATTESTATION_TYPES.filter((type) => type === TURN_EVIDENCE_ATTESTATION_TYPE)).toHaveLength(1);
  });

  it('classifies it as mechanical (never awaiting a countersignature)', () => {
    expect((MECHANICAL_ATTESTATION_TYPES as readonly string[]).includes(TURN_EVIDENCE_ATTESTATION_TYPE)).toBe(true);
  });
});

describe('hash determinism', () => {
  it('matches an independently computed SHA-256 for strings (UTF-8)', () => {
    const text = 'eth_getCode → 0x6080…';
    expect(hashToolIo(text)).toBe(`sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`);
  });

  it('matches SHA-256 of raw bytes for Uint8Array input', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251]);
    expect(hashToolIo(bytes)).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(sha256Hash(bytes)).toBe(hashToolIo(bytes));
  });

  it('is stable across calls and independent of object key order', () => {
    const a = { url: 'https://example.com', opts: { b: 2, a: 1 }, list: [1, 2, 3] };
    const b = { list: [1, 2, 3], opts: { a: 1, b: 2 }, url: 'https://example.com' };
    expect(hashToolIo(a)).toBe(hashToolIo(a));
    expect(hashToolIo(a)).toBe(hashToolIo(b));
  });

  it('hashes structured values as SHA-256 of their canonical JSON', () => {
    const value = { z: 1, a: [true, null] };
    expect(hashToolIo(value)).toBe(`sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`);
  });

  it('changes when a single byte of the input changes', () => {
    expect(hashToolIo('claim text')).not.toBe(hashToolIo('claim texu'));
    expect(hashToolIo({ n: 1 })).not.toBe(hashToolIo({ n: 2 }));
  });

  it('produces the canonical sha256:<64 lowercase hex> form', () => {
    expect(hashToolIo('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects undefined (no stable wire form)', () => {
    expect(() => hashToolIo(undefined)).toThrow(TypeError);
  });

  it('hashes null and the empty string deterministically and distinctly', () => {
    expect(hashToolIo(null)).toBe(hashToolIo(null));
    expect(hashToolIo(null)).not.toBe(hashToolIo(''));
  });
});

describe('normalizeHash', () => {
  it('accepts prefixed and bare hex, any case, and returns the canonical form', () => {
    expect(normalizeHash(`sha256:${HEX_A}`)).toBe(`sha256:${HEX_A}`);
    expect(normalizeHash(HEX_A)).toBe(`sha256:${HEX_A}`);
    expect(normalizeHash(`SHA256:${HEX_A.toUpperCase()}`)).toBe(`sha256:${HEX_A}`);
  });

  it('rejects anything else', () => {
    expect(normalizeHash('sha256:abc')).toBeNull();
    expect(normalizeHash(`md5:${HEX_A}`)).toBeNull();
    expect(normalizeHash(`${HEX_A}0`)).toBeNull();
    expect(normalizeHash(`sha256:${'g'.repeat(64)}`)).toBeNull();
    expect(normalizeHash(42)).toBeNull();
    expect(normalizeHash(undefined)).toBeNull();
  });
});

describe('buildTurnEvidencePayload', () => {
  it('matches the shape in the issue and omits absent optional keys', () => {
    const payload = buildTurnEvidencePayload(fields());
    expect(payload).toEqual({
      type: 'agent.turn.evidence',
      turnEventId: 'turn_evt_123',
      turnOutputHash: `sha256:${HEX_A}`,
      agentDid: 'did:imajin:agent',
      principalDid: 'did:imajin:principal',
      tool: { name: 'web_fetch', provider: 'openclaw' },
      inputHash: `sha256:${HEX_B}`,
      outputHash: `sha256:${HEX_C}`,
      observedAt: '2026-09-04T03:54:12Z',
      seq: 3,
    });
    expect('outputRef' in payload).toBe(false);
    expect('usageRef' in payload).toBe(false);
  });

  it('includes optional refs when given', () => {
    const payload = buildTurnEvidencePayload(fields({ outputRef: 'asset_abc', usageRef: 'att_xyz' }));
    expect(payload.outputRef).toBe('asset_abc');
    expect(payload.usageRef).toBe('att_xyz');
  });
});

describe('signing message', () => {
  it('is deterministic and binds subject, type, context and issued_at', () => {
    const payload = buildTurnEvidencePayload(fields());
    expect(turnEvidenceSigningMessage(payload, 1_700_000_000_000)).toBe(
      turnEvidenceSigningMessage(payload, 1_700_000_000_000),
    );
    expect(turnEvidenceSigningMessage(payload, 1_700_000_000_000)).not.toBe(
      turnEvidenceSigningMessage(payload, 1_700_000_000_001),
    );
    expect(turnEvidenceSigningFields(payload, 5)).toEqual({
      subject_did: 'did:imajin:agent',
      type: 'agent.turn.evidence',
      context_id: 'turn_evt_123',
      context_type: TURN_EVIDENCE_CONTEXT_TYPE,
      payload,
      issued_at: 5,
    });
  });

  it('changes when any evidence field changes', () => {
    const base = turnEvidenceSigningMessage(buildTurnEvidencePayload(fields()), 1);
    const altered = turnEvidenceSigningMessage(buildTurnEvidencePayload(fields({ outputHash: `sha256:${HEX_A}` })), 1);
    expect(altered).not.toBe(base);
  });
});

describe('parseTurnEvidencePayload', () => {
  const valid = () => buildTurnEvidencePayload(fields({ outputRef: 'asset_abc', usageRef: 'att_123abc' }));

  it('round-trips a built payload', () => {
    const parsed = parseTurnEvidencePayload(valid());
    expect(parsed).toEqual({ ok: true, value: valid() });
  });

  it('accepts fractional-second UTC timestamps and seq 0', () => {
    const parsed = parseTurnEvidencePayload({ ...valid(), observedAt: '2026-09-04T03:54:12.345Z', seq: 0 });
    expect(parsed.ok).toBe(true);
  });

  describe('redaction safety — nothing outside the closed vocabulary can ride along', () => {
    it.each([
      ['args', { url: 'https://example.com?token=sk-live-123' }],
      ['output', 'raw tool output with a secret'],
      ['authorization', 'Bearer sk-secret'],
      ['apiKey', 'sk-secret'],
      ['rawInput', { password: 'hunter2' }],
    ])('rejects an unknown top-level key (%s) without echoing its value', (key, value) => {
      const result = parseTurnEvidencePayload({ ...valid(), [key]: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(`payload.${key}`);
        expect(result.error).not.toContain('sk-');
        expect(result.error).not.toContain('hunter2');
      }
    });

    it('rejects unknown keys inside tool', () => {
      const result = parseTurnEvidencePayload({ ...valid(), tool: { name: 'web_fetch', provider: 'openclaw', args: 'x' } });
      expect(result).toEqual({ ok: false, error: 'payload.tool.args is not a recognized field (name|provider)' });
    });

    it('rejects free text in tool name/provider (charset-restricted identifiers)', () => {
      expect(parseTurnEvidencePayload({ ...valid(), tool: { name: 'fetch https://x.test?k=1', provider: 'openclaw' } }).ok).toBe(false);
      expect(parseTurnEvidencePayload({ ...valid(), tool: { name: 'web_fetch', provider: 'open claw' } }).ok).toBe(false);
      expect(parseTurnEvidencePayload({ ...valid(), tool: { name: 'a'.repeat(65), provider: 'openclaw' } }).ok).toBe(false);
    });

    it('rejects non-hash values in hash fields (raw content cannot occupy them)', () => {
      for (const key of ['inputHash', 'outputHash', 'turnOutputHash']) {
        const result = parseTurnEvidencePayload({ ...valid(), [key]: 'the raw page text' });
        expect(result.ok).toBe(false);
      }
    });

    it('requires the canonical prefixed lowercase hash form on the wire', () => {
      expect(parseTurnEvidencePayload({ ...valid(), inputHash: HEX_B }).ok).toBe(false);
      expect(parseTurnEvidencePayload({ ...valid(), inputHash: `sha256:${HEX_B.toUpperCase()}` }).ok).toBe(false);
    });
  });

  it.each([
    ['not an object', null, 'payload must be an object'],
    ['an array', [], 'payload must be an object'],
  ])('rejects a payload that is %s', (_label, raw, error) => {
    expect(parseTurnEvidencePayload(raw)).toEqual({ ok: false, error });
  });

  it.each([
    ['type', { type: 'agent.turn.usage' }],
    ['turnEventId', { turnEventId: 'has spaces' }],
    ['turnEventId (missing)', { turnEventId: undefined }],
    ['agentDid', { agentDid: 'not-a-did' }],
    ['agentDid (whitespace)', { agentDid: 'did:imajin: x' }],
    ['principalDid', { principalDid: 42 }],
    ['tool', { tool: 'web_fetch' }],
    ['outputRef', { outputRef: 'bad ref!' }],
    ['usageRef', { usageRef: 'not_att_id' }],
    ['observedAt (format)', { observedAt: '2026-09-04 03:54:12' }],
    ['observedAt (non-UTC)', { observedAt: '2026-09-04T03:54:12+02:00' }],
    ['observedAt (impossible)', { observedAt: '2026-13-45T25:61:61Z' }],
    ['seq (negative)', { seq: -1 }],
    ['seq (fraction)', { seq: 1.5 }],
    ['seq (string)', { seq: '3' }],
    ['seq (too large)', { seq: 10_000 }],
  ])('rejects an invalid %s', (_label, override) => {
    expect(parseTurnEvidencePayload({ ...valid(), ...override }).ok).toBe(false);
  });

  it('rejects an over-long DID', () => {
    expect(parseTurnEvidencePayload({ ...valid(), agentDid: `did:imajin:${'x'.repeat(300)}` }).ok).toBe(false);
  });
});
