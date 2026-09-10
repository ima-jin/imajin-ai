import { describe, it, expect } from 'vitest';
import { parseArgs, scopeForOwner } from '../lib/migrate-owner-filter.mjs';

describe('parseArgs', () => {
  it('returns no owner and includeShared=false for an empty argv (default behavior)', () => {
    expect(parseArgs([])).toEqual({ owner: null, includeShared: false });
  });

  it('parses "--owner <name>" as two argv entries', () => {
    expect(parseArgs(['--owner', 'links'])).toEqual({ owner: 'links', includeShared: false });
  });

  it('parses "--owner=<name>"', () => {
    expect(parseArgs(['--owner=links'])).toEqual({ owner: 'links', includeShared: false });
  });

  it('parses --include-shared alongside --owner', () => {
    expect(parseArgs(['--owner', 'links', '--include-shared'])).toEqual({
      owner: 'links',
      includeShared: true,
    });
  });

  it('accepts flags in either order', () => {
    expect(parseArgs(['--include-shared', '--owner', 'links'])).toEqual({
      owner: 'links',
      includeShared: true,
    });
  });

  it('throws on --include-shared without --owner', () => {
    expect(() => parseArgs(['--include-shared'])).toThrow(/--include-shared requires --owner/);
  });

  it('throws on an unknown owner', () => {
    expect(() => parseArgs(['--owner', 'not-a-real-app'])).toThrow(/unknown owner "not-a-real-app"/);
  });

  it('throws on an unrecognized argument', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unrecognized argument "--bogus"/);
  });

  it('accepts every valid owner name from ALL_OWNERS', () => {
    for (const owner of ['kernel', 'coffee', 'dykil', 'events', 'learn', 'links', 'market', 'broker-agent', 'corpus']) {
      expect(() => parseArgs(['--owner', owner])).not.toThrow();
    }
  });
});

describe('scopeForOwner', () => {
  const linksSql = 'CREATE TABLE IF NOT EXISTS links.pages (id INT);';
  const dykilSql = 'CREATE TABLE IF NOT EXISTS dykil.surveys (id INT);';
  const sharedSql = 'CREATE TABLE IF NOT EXISTS links.pages (id INT); CREATE TABLE IF NOT EXISTS dykil.surveys (id INT);';

  it('includes everything when no owner filter is set (default, unchanged)', () => {
    expect(scopeForOwner(linksSql, null, false)).toEqual({ include: true });
    expect(scopeForOwner(sharedSql, null, false)).toEqual({ include: true });
  });

  it('includes a file owned solely by the requested owner', () => {
    expect(scopeForOwner(linksSql, 'links', false)).toEqual({ include: true });
  });

  it('excludes a file owned solely by a different single owner, with a reason', () => {
    const result = scopeForOwner(dykilSql, 'links', false);
    expect(result.include).toBe(false);
    expect(result.reason).toMatch(/owned by "dykil", not "links"/);
  });

  it('excludes a shared file for a non-kernel owner without --include-shared', () => {
    const result = scopeForOwner(sharedSql, 'links', false);
    expect(result.include).toBe(false);
    expect(result.reason).toMatch(/shared across owners/);
    expect(result.reason).toMatch(/--include-shared/);
  });

  it('includes a shared file for a non-kernel owner when --include-shared is set', () => {
    expect(scopeForOwner(sharedSql, 'links', true)).toEqual({ include: true });
  });

  it('always includes a shared file for --owner kernel, even without --include-shared', () => {
    expect(scopeForOwner(sharedSql, 'kernel', false)).toEqual({ include: true });
  });

  it('treats the real 0001_seed.sql shape (many owners) as shared, included only for kernel or --include-shared', () => {
    const seedLikeSql = `
      CREATE TABLE IF NOT EXISTS auth.identities (did TEXT);
      CREATE TABLE IF NOT EXISTS links.pages (id INT);
      CREATE TABLE IF NOT EXISTS dykil.surveys (id INT);
      CREATE TABLE IF NOT EXISTS coffee.pages (id INT);
    `;
    expect(scopeForOwner(seedLikeSql, 'kernel', false)).toEqual({ include: true });
    expect(scopeForOwner(seedLikeSql, 'links', false).include).toBe(false);
    expect(scopeForOwner(seedLikeSql, 'links', true)).toEqual({ include: true });
  });
});
