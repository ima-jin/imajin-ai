/**
 * Tests for the shared profile jsonb size guard (#2432): every guarded field
 * is exercised at the limit (accepted) and at limit+1 (rejected, error names
 * the field) on each of the three axes — entries, string length, bytes.
 */
import { describe, it, expect } from 'vitest';
import { PROFILE_JSONB_LIMITS, validateJsonbSize } from '../jsonb-limits';
import type { ProfileJsonbField } from '../jsonb-limits';

const FIELDS = Object.keys(PROFILE_JSONB_LIMITS) as ProfileJsonbField[];

/** taxRegistrations is an array; every other guarded field is an object. */
function isArrayField(field: ProfileJsonbField): boolean {
  return field === 'taxRegistrations';
}

function withEntries(field: ProfileJsonbField, count: number): unknown {
  if (isArrayField(field)) return Array.from({ length: count }, (_, i) => ({ n: i }));
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, true]));
}

function withString(field: ProfileJsonbField, length: number): unknown {
  const text = 'x'.repeat(length);
  return isArrayField(field) ? [{ label: text }] : { note: text };
}

/** One top-level entry holding a nested array of strings: size grows without touching the entry/string caps. */
function wrapStrings(field: ProfileJsonbField, strings: string[]): unknown {
  return isArrayField(field) ? [strings] : { filler: strings };
}

function measure(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Build a value for `field` whose serialized JSON is exactly `target` bytes, with every string within the string cap. */
function withBytes(field: ProfileJsonbField, target: number): unknown {
  const { maxStringLength } = PROFILE_JSONB_LIMITS[field];
  const contentBytes = target - measure(wrapStrings(field, []));
  // n strings cost 3n - 1 bytes of quotes/commas on top of their characters.
  const count = Math.ceil((contentBytes + 1) / (maxStringLength + 3));
  const totalChars = contentBytes - 3 * count + 1;
  const base = Math.floor(totalChars / count);
  const extra = totalChars % count;
  const strings = Array.from({ length: count }, (_, i) => 'x'.repeat(base + (i < extra ? 1 : 0)));
  const value = wrapStrings(field, strings);
  expect(measure(value)).toBe(target);
  return value;
}

describe('validateJsonbSize (#2432)', () => {
  it.each(FIELDS)('%s: accepts exactly maxEntries entries and rejects maxEntries+1', (field) => {
    const { maxEntries } = PROFILE_JSONB_LIMITS[field];
    expect(validateJsonbSize(field, withEntries(field, maxEntries)).valid).toBe(true);

    const over = validateJsonbSize(field, withEntries(field, maxEntries + 1));
    expect(over.valid).toBe(false);
    expect(over.field).toBe(field);
    expect(over.error).toContain(field);
    expect(over.error).toMatch(/too many entries/);
  });

  it.each(FIELDS)('%s: accepts a string of exactly maxStringLength and rejects maxStringLength+1', (field) => {
    const { maxStringLength } = PROFILE_JSONB_LIMITS[field];
    expect(validateJsonbSize(field, withString(field, maxStringLength)).valid).toBe(true);

    const over = validateJsonbSize(field, withString(field, maxStringLength + 1));
    expect(over.valid).toBe(false);
    expect(over.field).toBe(field);
    expect(over.error).toContain(field);
    expect(over.error).toMatch(/string that is too long/);
  });

  it.each(FIELDS)('%s: accepts exactly maxBytes serialized bytes and rejects maxBytes+1', (field) => {
    const { maxBytes } = PROFILE_JSONB_LIMITS[field];
    expect(validateJsonbSize(field, withBytes(field, maxBytes)).valid).toBe(true);

    const over = validateJsonbSize(field, withBytes(field, maxBytes + 1));
    expect(over.valid).toBe(false);
    expect(over.field).toBe(field);
    expect(over.error).toContain(field);
    expect(over.error).toMatch(/too large/);
  });

  it.each(FIELDS)('%s: treats null and undefined as valid (clearing a field)', (field) => {
    expect(validateJsonbSize(field, undefined).valid).toBe(true);
    expect(validateJsonbSize(field, null).valid).toBe(true);
  });

  it('measures the cap on strings nested at any depth', () => {
    const { maxStringLength } = PROFILE_JSONB_LIMITS.metadata;
    const nested = { a: { b: [{ c: 'x'.repeat(maxStringLength + 1) }] } };
    expect(validateJsonbSize('metadata', nested).valid).toBe(false);
  });

  it('measures the cap on object keys too', () => {
    const { maxStringLength } = PROFILE_JSONB_LIMITS.metadata;
    expect(validateJsonbSize('metadata', { ['k'.repeat(maxStringLength + 1)]: 1 }).valid).toBe(false);
  });

  it('counts bytes, not characters, for multibyte text', () => {
    // 'é' is 1 character but 2 UTF-8 bytes: each row sits within the string cap,
    // and the row count is chosen so only the byte count (not the char count) exceeds maxBytes.
    const { maxBytes, maxStringLength } = PROFILE_JSONB_LIMITS.featureToggles;
    const chars = maxStringLength;
    const rows = Math.floor(maxBytes / chars) - 1; // chars total just under maxBytes
    expect(rows * chars).toBeLessThan(maxBytes);
    const value = { rows: Array.from({ length: rows }, () => 'é'.repeat(chars)) };
    const result = validateJsonbSize('featureToggles', value);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too large/);
  });

  it('does not throw on a value JSON cannot serialize', () => {
    const result = validateJsonbSize('metadata', { big: BigInt(1) });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not serializable/);
  });

  it('does not overflow the stack on deeply nested input', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50_000; i++) deep = [deep];
    expect(() => validateJsonbSize('metadata', { deep })).not.toThrow();
  });
});
