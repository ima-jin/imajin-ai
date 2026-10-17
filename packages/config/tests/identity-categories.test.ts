import { describe, expect, it } from 'vitest';
import { IDENTITY_CATEGORIES } from '../src/identity-categories';

describe('identity category taxonomy', () => {
  it('preserves every previously stored preset spelling', () => {
    expect(IDENTITY_CATEGORIES).toEqual(expect.arrayContaining([
      'café', 'restaurant', 'shop', 'venue', 'studio', 'bar', 'gallery', 'gym',
    ]));
  });

  it('includes trades and service categories with unique, nonempty values', () => {
    expect(IDENTITY_CATEGORIES).toEqual(expect.arrayContaining([
      'contractor', 'trades', 'professional services', 'health',
    ]));
    expect(new Set(IDENTITY_CATEGORIES).size).toBe(IDENTITY_CATEGORIES.length);
    expect(IDENTITY_CATEGORIES.every(value => value.trim() === value && value.length > 0)).toBe(true);
  });
});
