import { describe, it, expect } from 'vitest';
import { rewriteMarkdownRefs, normalizeLocalPath } from '../markdown-refs';

describe('normalizeLocalPath', () => {
  it('strips a leading ./', () => {
    expect(normalizeLocalPath('./pic.png')).toBe('pic.png');
  });

  it('strips a leading /', () => {
    expect(normalizeLocalPath('/pic.png')).toBe('pic.png');
  });

  it('leaves a bare relative path untouched', () => {
    expect(normalizeLocalPath('images/pic.png')).toBe('images/pic.png');
  });
});

describe('rewriteMarkdownRefs', () => {
  const resolve = (path: string) => (path === 'pic.png' ? 'https://node.example/media/api/assets/asset_pic' : null);

  it('rewrites a local image ref to the resolved asset URL', () => {
    const result = rewriteMarkdownRefs('![alt](./pic.png)', resolve);

    expect(result.content).toBe('![alt](https://node.example/media/api/assets/asset_pic)');
    expect(result.rewritten).toEqual([{ from: './pic.png', to: 'https://node.example/media/api/assets/asset_pic' }]);
    expect(result.unresolved).toEqual([]);
  });

  it('rewrites a local link ref (non-image) the same way', () => {
    const result = rewriteMarkdownRefs('[report](pic.png)', resolve);

    expect(result.content).toBe('[report](https://node.example/media/api/assets/asset_pic)');
    expect(result.rewritten).toHaveLength(1);
  });

  it('leaves external http(s) refs untouched and does not flag them unresolved', () => {
    const result = rewriteMarkdownRefs('![ext](https://example.com/photo.jpg)', resolve);

    expect(result.content).toBe('![ext](https://example.com/photo.jpg)');
    expect(result.rewritten).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('leaves data: and mailto: and #fragment refs untouched', () => {
    const input = '![d](data:image/png;base64,AAAA) [m](mailto:a@b.com) [f](#section)';
    const result = rewriteMarkdownRefs(input, resolve);

    expect(result.content).toBe(input);
    expect(result.rewritten).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('reports an unresolvable local ref instead of silently leaving it', () => {
    const result = rewriteMarkdownRefs('![missing](./missing.png)', resolve);

    expect(result.content).toBe('![missing](./missing.png)');
    expect(result.rewritten).toEqual([]);
    expect(result.unresolved).toEqual(['./missing.png']);
  });

  it('de-dupes repeated unresolved refs', () => {
    const result = rewriteMarkdownRefs('![a](./x.png) and again ![b](./x.png)', resolve);

    expect(result.unresolved).toEqual(['./x.png']);
  });

  it('rewrites multiple distinct refs in one document', () => {
    const multiResolve = (path: string) =>
      ({ 'a.png': 'https://n/media/api/assets/a', 'b.png': 'https://n/media/api/assets/b' })[path] ?? null;

    const result = rewriteMarkdownRefs('![a](a.png) ![b](./b.png) ![c](./c.png)', multiResolve);

    expect(result.content).toBe('![a](https://n/media/api/assets/a) ![b](https://n/media/api/assets/b) ![c](./c.png)');
    expect(result.rewritten).toEqual([
      { from: 'a.png', to: 'https://n/media/api/assets/a' },
      { from: './b.png', to: 'https://n/media/api/assets/b' },
    ]);
    expect(result.unresolved).toEqual(['./c.png']);
  });

  it.each([
    ['[a](pic.png "caption")', '[a](https://node.example/media/api/assets/asset_pic)'],
    ['![a](pic.png \n "caption")', '![a](https://node.example/media/api/assets/asset_pic)'],
    ['[[a](pic.png)', '[[a](https://node.example/media/api/assets/asset_pic)'],
    ['[a](pic.png )', '[a](pic.png )'],
    ['[a](pic.png"caption")', '[a](pic.png"caption")'],
    ['[a](pic.png "unfinished)', '[a](pic.png "unfinished)'],
    ['[a](pic.png "")', '[a](https://node.example/media/api/assets/asset_pic)'],
    ['[a]()', '[a]()'],
    ['[a](', '[a]('],
  ])('preserves reference syntax for %s', (input, expected) => {
    expect(rewriteMarkdownRefs(input, resolve).content).toBe(expected);
  });

  it('finds a valid link inside an invalid outer target', () => {
    expect(rewriteMarkdownRefs('[outer](bad[inner](pic.png)', resolve).unresolved)
      .toEqual(['bad[inner](pic.png']);
    expect(rewriteMarkdownRefs('[outer](bad"[inner](pic.png)', resolve).content)
      .toBe('[outer](bad"[inner](https://node.example/media/api/assets/asset_pic)');
  });

  it.each([
    '['.repeat(100_000),
    '[a]('.repeat(20_000),
    '[a](pic.png "' + ' '.repeat(100_000),
  ])('handles long malformed input without rescanning tails (%#)', (input) => {
    expect(rewriteMarkdownRefs(input, resolve).content).toBe(input);
  });
});
