import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { MAX_FILENAME_BYTES, resolveInside, safeExtension, validateFilename } from '../safe-path';

describe('validateFilename', () => {
  it('accepts a normal name and trims surrounding whitespace', () => {
    expect(validateFilename('  notes v2.md ')).toEqual({ ok: true, filename: 'notes v2.md' });
  });

  it('accepts a name of exactly the maximum byte length', () => {
    const name = 'a'.repeat(MAX_FILENAME_BYTES);
    expect(validateFilename(name)).toEqual({ ok: true, filename: name });
  });

  it.each([
    ['undefined', undefined],
    ['a number', 7],
    ['empty', ''],
    ['whitespace only', '   '],
    ['dot', '.'],
    ['dot-dot', '..'],
    ['padded dot-dot', ' .. '],
    ['forward slash', 'a/b'],
    ['parent traversal', '../x'],
    ['backslash', 'a\\b'],
    ['backslash traversal', '..\\x'],
    ['absolute path', '/etc/passwd'],
    ['NUL', 'a\0b'],
    ['newline', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['C1 control', 'a\u0085b'],
    ['over-long', 'a'.repeat(MAX_FILENAME_BYTES + 1)],
    ['over-long multibyte', 'é'.repeat(MAX_FILENAME_BYTES)],
  ])('rejects %s', (_label, input) => {
    expect(validateFilename(input).ok).toBe(false);
  });
});

describe('resolveInside', () => {
  const base = path.resolve('/srv/media/owner/assets');

  it('resolves a safe name inside the directory', () => {
    expect(resolveInside(base, 'a.txt')).toBe(path.join(base, 'a.txt'));
  });

  it.each(['../x', '../../etc/passwd', '..', '.', 'a/b', '/etc/passwd', 'a\0b', ''])(
    'returns null for %j',
    (name) => {
      expect(resolveInside(base, name)).toBeNull();
    },
  );
});

describe('safeExtension', () => {
  it.each([
    ['photo.png', '.png'],
    ['archive.tar.gz', '.gz'],
    ['NOTES.MD', '.MD'],
    ['noext', ''],
    ['.hidden', ''],
    ['x.a\\..\\b', ''],
    ['x.\0md', ''],
    ['x.é', ''],
    ['x.' + 'a'.repeat(40), ''],
    ['../../x.png', '.png'],
  ])('%j -> %j', (input, expected) => {
    expect(safeExtension(input)).toBe(expected);
  });
});
