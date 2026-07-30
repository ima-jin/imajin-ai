import { describe, it, expect } from 'vitest';
import { isRepoAllowed, isOrgAllowed, filterRepos, filterOrgs } from '../allowlist-match';

// ── Disclosure allowlist matchers (#1373) ─────────────────────────────────────
//
// These are the pure, I/O-free matchers used to filter discovery results
// server-side. `readReadAllowlist` (which reads the manifest asset) is exercised
// via the connector tests where the manifest read is mocked.

describe('isRepoAllowed (#1373)', () => {
  it('allow-all when the allowlist is null', () => {
    expect(isRepoAllowed('ima-jin/imajin-ai', null)).toBe(true);
    expect(isRepoAllowed('anyone/anything', null)).toBe(true);
  });

  it('allows an exact owner/repo match (case-insensitive)', () => {
    const list = new Set(['ima-jin/imajin-ai']);
    expect(isRepoAllowed('ima-jin/imajin-ai', list)).toBe(true);
    expect(isRepoAllowed('IMA-JIN/Imajin-AI', list)).toBe(true);
  });

  it('allows any repo under an org-level entry', () => {
    const list = new Set(['ima-jin']);
    expect(isRepoAllowed('ima-jin/imajin-ai', list)).toBe(true);
    expect(isRepoAllowed('ima-jin/conventions', list)).toBe(true);
  });

  it('drops repos not covered by the allowlist', () => {
    const list = new Set(['ima-jin/imajin-ai']);
    expect(isRepoAllowed('ima-jin/other-repo', list)).toBe(false);
    expect(isRepoAllowed('someone-else/repo', list)).toBe(false);
  });

  it('fail-closed on an ambiguous (ownerless) full name', () => {
    const list = new Set(['ima-jin']);
    expect(isRepoAllowed('imajin-ai', list)).toBe(false);
    expect(isRepoAllowed('', list)).toBe(false);
  });
});

describe('isOrgAllowed (#1373)', () => {
  it('allow-all when the allowlist is null', () => {
    expect(isOrgAllowed('ima-jin', null)).toBe(true);
  });

  it('allows an org listed directly (case-insensitive)', () => {
    const list = new Set(['ima-jin']);
    expect(isOrgAllowed('ima-jin', list)).toBe(true);
    expect(isOrgAllowed('IMA-JIN', list)).toBe(true);
  });

  it('discloses an org that owns a listed repo', () => {
    const list = new Set(['ima-jin/imajin-ai']);
    expect(isOrgAllowed('ima-jin', list)).toBe(true);
  });

  it('drops an org neither listed nor owning a listed repo', () => {
    const list = new Set(['ima-jin']);
    expect(isOrgAllowed('other-org', list)).toBe(false);
  });

  it('fail-closed on an empty/undetermined login', () => {
    const list = new Set(['ima-jin']);
    expect(isOrgAllowed('', list)).toBe(false);
    expect(isOrgAllowed('   ', list)).toBe(false);
  });
});

describe('filterRepos / filterOrgs (#1373)', () => {
  it('filterRepos returns all repos under allow-all and only matches otherwise', () => {
    const repos = [
      { full_name: 'ima-jin/imajin-ai' },
      { full_name: 'ima-jin/conventions' },
      { full_name: 'stranger/secret' },
    ];
    expect(filterRepos(repos, null)).toHaveLength(3);
    expect(filterRepos(repos, new Set(['ima-jin/imajin-ai'])).map((r) => r.full_name)).toEqual([
      'ima-jin/imajin-ai',
    ]);
    expect(filterRepos(repos, new Set(['ima-jin'])).map((r) => r.full_name)).toEqual([
      'ima-jin/imajin-ai',
      'ima-jin/conventions',
    ]);
  });

  it('filterOrgs returns all orgs under allow-all and only matches otherwise', () => {
    const orgs = [{ login: 'ima-jin' }, { login: 'stranger' }];
    expect(filterOrgs(orgs, null)).toHaveLength(2);
    expect(filterOrgs(orgs, new Set(['ima-jin'])).map((o) => o.login)).toEqual(['ima-jin']);
    expect(filterOrgs(orgs, new Set(['ima-jin/imajin-ai'])).map((o) => o.login)).toEqual(['ima-jin']);
  });
});
