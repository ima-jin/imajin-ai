import { describe, it, expect, vi } from 'vitest';
import {
  fixPlaceholderCallbackUrls,
  parseNodeOrigin,
  planRowFix,
  rewritePlaceholderUrl,
} from '../lib/placeholder-callback-urls.mjs';

const ORIGIN = 'https://jin.imajin.ai';

describe('rewritePlaceholderUrl', () => {
  it('swaps the placeholder origin and keeps the path, query and hash', () => {
    expect(rewritePlaceholderUrl('https://your-node.imajin.ai/links', ORIGIN)).toBe('https://jin.imajin.ai/links');
    expect(rewritePlaceholderUrl('https://your-node.imajin.ai', ORIGIN)).toBe('https://jin.imajin.ai');
    expect(rewritePlaceholderUrl('http://your-node.imajin.ai:3000/a?b=1#c', ORIGIN)).toBe('https://jin.imajin.ai/a?b=1#c');
  });

  it.each([
    ['an already-fixed host', 'https://jin.imajin.ai/links'],
    ['a lookalike host', 'https://your-node.imajin.ai.evil.example/links'],
    ['a host that merely ends in the placeholder', 'https://my-your-node.imajin.ai/links'],
    ['a non-string', null],
  ])('leaves %s alone', (_label, url) => {
    expect(rewritePlaceholderUrl(url, ORIGIN)).toBeNull();
  });
});

describe('parseNodeOrigin', () => {
  it('normalises to a bare origin', () => {
    expect(parseNodeOrigin('https://jin.imajin.ai/some/path/')).toBe('https://jin.imajin.ai');
  });

  it.each([
    ['nothing', '', 'no node public URL'],
    ['garbage', 'not a url', 'not a valid URL'],
    ['a non-http scheme', 'ftp://jin.imajin.ai', 'must be http(s)'],
    ['the placeholder itself', 'https://your-node.imajin.ai', 'placeholder host'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseNodeOrigin(value)).toThrow(message);
  });
});

describe('planRowFix', () => {
  it('rewrites callback_url and the redirect_uris copy of it', () => {
    const fix = planRowFix(
      {
        id: 'app_first_party_dykil',
        slug: null,
        tier: 'first_party',
        callback_url: 'https://your-node.imajin.ai/dykil',
        redirect_uris: ['https://your-node.imajin.ai/dykil', 'https://other.example/cb'],
      },
      ORIGIN,
    );
    expect(fix?.callbackUrl.to).toBe('https://jin.imajin.ai/dykil');
    expect(fix?.redirectUris).toMatchObject({
      changed: true,
      to: ['https://jin.imajin.ai/dykil', 'https://other.example/cb'],
    });
  });

  it('handles a row with an empty or missing redirect_uris', () => {
    const fix = planRowFix({ id: 'a', callback_url: 'https://your-node.imajin.ai/x', redirect_uris: null }, ORIGIN);
    expect(fix?.redirectUris).toMatchObject({ changed: false, to: [] });
    expect(fix?.slug).toBeNull();
  });

  it('only rewrites redirect_uris when callback_url is already clean', () => {
    const fix = planRowFix(
      { id: 'a', callback_url: 'https://jin.imajin.ai/x', redirect_uris: ['https://your-node.imajin.ai/x'] },
      ORIGIN,
    );
    expect(fix?.callbackUrl.to).toBe('https://jin.imajin.ai/x');
    expect(fix?.redirectUris.changed).toBe(true);
  });

  it('returns null for a row that is already fixed', () => {
    expect(
      planRowFix({ id: 'a', callback_url: 'https://jin.imajin.ai/x', redirect_uris: ['https://jin.imajin.ai/x'] }, ORIGIN),
    ).toBeNull();
  });
});

function fakeSql(rows) {
  const writes = [];
  const sql = (strings, ...values) => {
    if (strings.join('?').includes('UPDATE')) writes.push(values);
    return Promise.resolve(rows);
  };
  sql.begin = (fn) => fn(sql);
  sql.array = (value) => value;
  sql.writes = writes;
  return sql;
}

const PLACEHOLDER_ROWS = [
  { id: 'app_a', slug: 'links', tier: 'third_party', callback_url: 'https://your-node.imajin.ai/links', redirect_uris: [] },
  { id: 'app_b', slug: null, tier: 'first_party', callback_url: 'https://your-node.imajin.ai/dykil', redirect_uris: ['https://your-node.imajin.ai/dykil'] },
  { id: 'app_c', slug: 'coffee', tier: 'third_party', callback_url: 'https://dev-jin.imajin.ai/coffee', redirect_uris: [] },
];

describe('fixPlaceholderCallbackUrls', () => {
  it('is a dry run by default: prints the rows and writes nothing', async () => {
    const sql = fakeSql(PLACEHOLDER_ROWS);
    const log = vi.fn();

    const fixes = await fixPlaceholderCallbackUrls({ sql, origin: ORIGIN, log });

    expect(fixes.map((f) => f.id)).toEqual(['app_a', 'app_b']);
    expect(sql.writes).toHaveLength(0);
    const output = log.mock.calls.map(([line]) => line).join('\n');
    expect(output).toContain('app_a');
    expect(output).toContain('https://your-node.imajin.ai/links -> https://jin.imajin.ai/links');
    expect(output).not.toContain('app_c');
    expect(output).toContain('DRY RUN');
  });

  it('with apply, updates only rows still on the placeholder host', async () => {
    const sql = fakeSql(PLACEHOLDER_ROWS);
    const log = vi.fn();

    await fixPlaceholderCallbackUrls({ sql, origin: ORIGIN, apply: true, log });

    expect(sql.writes).toEqual([
      ['https://jin.imajin.ai/links', [], 'app_a'],
      ['https://jin.imajin.ai/dykil', ['https://jin.imajin.ai/dykil'], 'app_b'],
    ]);
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('APPLIED — updated 2 row(s)');
  });

  it('reports nothing to do, and opens no transaction, when no row carries the placeholder', async () => {
    const sql = fakeSql([PLACEHOLDER_ROWS[2]]);
    const begin = vi.spyOn(sql, 'begin');
    const log = vi.fn();

    const fixes = await fixPlaceholderCallbackUrls({ sql, origin: ORIGIN, apply: true, log });

    expect(fixes).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('APPLIED — updated 0 row(s)');
  });

  it('says there is nothing to do on a clean dry run', async () => {
    const log = vi.fn();
    await fixPlaceholderCallbackUrls({ sql: fakeSql([]), origin: ORIGIN, log });
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('Nothing to do');
  });
});
