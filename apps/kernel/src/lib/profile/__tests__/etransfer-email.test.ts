import { describe, it, expect } from 'vitest';
import { validateEtransferEmail } from '../etransfer-email';

describe('validateEtransferEmail (#2665)', () => {
  it('accepts an ordinary address, trimmed and lower-cased', () => {
    expect(validateEtransferEmail('  Payments@Acme.Example ')).toEqual({ valid: true, normalized: 'payments@acme.example' });
    expect(validateEtransferEmail('a.b+c@sub.example.ca')).toEqual({ valid: true, normalized: 'a.b+c@sub.example.ca' });
  });

  it.each([null, undefined, '', '   '])('treats %j as "clear it" — valid, normalised to null', (raw) => {
    expect(validateEtransferEmail(raw)).toEqual({ valid: true, normalized: null });
  });

  it.each([
    [42, /string/],
    [{}, /string/],
    ['plainaddress', /exactly one @/],
    ['a@b@c.com', /exactly one @/],
    ['@acme.example', /name before the @/],
    ['a b@acme.example', /spaces/],
    ['a@acme example.com', /spaces/],
    ['a@acme', /domain/],
    ['a@.example.com', /domain/],
    ['a@example..com', /domain/],
    ['a@example.com.', /domain/],
    ['a@-example.com', /invalid domain/],
    ['a@example-.com', /invalid domain/],
  ])('rejects %j', (raw, message) => {
    const result = validateEtransferEmail(raw);
    expect(result.valid).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.error).toMatch(message);
  });

  it('rejects a local part over 64 characters and an address over 254', () => {
    expect(validateEtransferEmail(`${'a'.repeat(65)}@acme.example`).valid).toBe(false);
    expect(validateEtransferEmail(`${'a'.repeat(64)}@acme.example`).valid).toBe(true);
    expect(validateEtransferEmail(`a@${'b'.repeat(250)}.com`).valid).toBe(false);
  });
});
