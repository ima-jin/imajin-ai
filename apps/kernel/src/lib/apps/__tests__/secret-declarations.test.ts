import { describe, expect, it } from 'vitest';
import { validateSecrets } from '../secret-declarations';
import { parseManifestDeclarations, sameDeclarations } from '../declarations-approval';

describe('app secret recipes', () => {
  it('accepts only names and a small generated/operator-input kind vocabulary', () => {
    expect(validateSecrets([{ name: 'SESSION_SECRET', kind: 'random-32B' }])).toEqual({
      ok: [{ name: 'SESSION_SECRET', kind: 'random-32B' }],
    });
    expect(validateSecrets(undefined)).toEqual({ ok: [] });
    expect(validateSecrets([{ name: 'TICKET_QR_SECRET', kind: 'random-64B' }])).toHaveProperty('ok');
    expect(validateSecrets([{ name: 'DATABASE_URL', kind: 'operator-supplied' }])).toEqual({
      ok: [{ name: 'DATABASE_URL', kind: 'operator-supplied' }],
    });
  });

  it.each([
    null, {}, [null], ['SESSION_SECRET'],
    [{ name: 'bad:name', kind: 'random-32B' }],
    [{ name: 'SESSION_SECRET', kind: 'arbitrary' }],
    [{ name: 'SESSION_SECRET', kind: 'random-32B', value: 'obviously-fake-placeholder' }],
    [{ name: 'DATABASE_URL', kind: 'operator-supplied', value: 'obviously-fake-placeholder' }],
    [{ name: 'DATABASE_URL', kind: 'operator-supplied', valueHash: 'obviously-fake-placeholder' }],
    [{ name: 'SESSION_SECRET', kind: 'random-32B' }, { name: 'SESSION_SECRET', kind: 'random-32B' }],
    [{ name: 'A'.repeat(65), kind: 'random-32B' }],
    Array.from({ length: 33 }, (_, i) => ({ name: `SECRET_${i}`, kind: 'random-32B' })),
  ].map((input) => [input]))('rejects malformed declarations without reflecting input values', (input) => {
    const result = validateSecrets(input);
    expect(result).toHaveProperty('error');
    expect(JSON.stringify(result)).not.toContain('obviously-fake-placeholder');
  });

  it('binds approved names and kinds while reading pre-feature proposals as empty', () => {
    const empty = { providesScopes: [], dependsOn: [], emittableEvents: [] };
    expect(parseManifestDeclarations(empty)).toEqual(empty);
    const declared = { ...empty, secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B' as const }] };
    expect(sameDeclarations(declared, empty)).toBe(false);
    expect(sameDeclarations(declared, { ...declared, secrets: [{ name: 'SESSION_SECRET', kind: 'random-64B' }] })).toBe(false);
    expect(parseManifestDeclarations({ ...declared, secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B', value: 'obviously-fake-placeholder' }] })).toBeNull();
  });
});
