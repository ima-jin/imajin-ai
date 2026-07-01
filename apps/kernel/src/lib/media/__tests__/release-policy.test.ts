import { describe, it, expect } from 'vitest';
import {
  parseReleasePolicy,
  deriveReleaseTier,
  TIER_RANK,
  type ParsedReleasePolicy,
} from '../release-policy';
import { composeArticleFile } from '../frontmatter';
import type { ArticleBlock } from '../article-core';

/** Narrow the union to the success shape (throws in-test if it's an error). */
function ok(result: ParsedReleasePolicy | { error: string }): ParsedReleasePolicy {
  if ('error' in result) throw new Error(`expected success, got error: ${result.error}`);
  return result;
}

describe('deriveReleaseTier (#1196 2x2)', () => {
  it('maps each quadrant to a monotonic tier', () => {
    expect(deriveReleaseTier({ disclosesOthers: false, sensitive: false })).toBe('silent');
    expect(deriveReleaseTier({ disclosesOthers: true, sensitive: false })).toBe('on-consent');
    expect(deriveReleaseTier({ disclosesOthers: false, sensitive: true })).toBe('owner-only');
    expect(deriveReleaseTier({ disclosesOthers: true, sensitive: true })).toBe('never');
  });

  it('is monotonic in restrictiveness: both-false is loosest, both-true is tightest', () => {
    expect(TIER_RANK[deriveReleaseTier({ disclosesOthers: false, sensitive: false })]).toBe(0);
    expect(TIER_RANK[deriveReleaseTier({ disclosesOthers: true, sensitive: true })]).toBe(3);
  });
});

describe('parseReleasePolicy — valid headers → typed policy', () => {
  it('derives the tier from the 2x2 classification', () => {
    const md = [
      '---',
      'release:',
      '  bio:',
      '    discloses_others: false',
      '    sensitive: false',
      '  ssn:',
      '    discloses_others: false',
      '    sensitive: true',
      '  friend_list:',
      '    discloses_others: true',
      '    sensitive: false',
      '---',
      'body',
    ].join('\n');
    const { releasePolicy } = ok(parseReleasePolicy(md));
    expect(releasePolicy.bio.release).toBe('silent');
    expect(releasePolicy.ssn.release).toBe('owner-only');
    expect(releasePolicy.friend_list.release).toBe('on-consent');
    // proof_grade defaults to the weaker `asserted` when omitted.
    expect(releasePolicy.bio.proof_grade).toBe('asserted');
  });

  it('captures viewer scope and proof_grade', () => {
    const md = [
      '---',
      'release:',
      '  email:',
      '    discloses_others: false',
      '    sensitive: true',
      '    viewer: connections',
      '    proof_grade: signed',
      '---',
    ].join('\n');
    const { releasePolicy } = ok(parseReleasePolicy(md));
    expect(releasePolicy.email).toEqual({
      release: 'owner-only',
      viewer: 'connections',
      proof_grade: 'signed',
    });
  });

  it('accepts an override that TIGHTENS the derived tier', () => {
    const md = [
      '---',
      'release:',
      '  bio:',
      '    discloses_others: false',
      '    sensitive: false',
      '    release: owner-only',
      '---',
    ].join('\n');
    const { releasePolicy } = ok(parseReleasePolicy(md));
    // derived = silent, override owner-only is stricter → allowed.
    expect(releasePolicy.bio.release).toBe('owner-only');
  });

  it('defaults an unclassified field to the most restrictive tier (fail-closed)', () => {
    const md = ['---', 'release:', '  mystery: {}', '---'].join('\n');
    const { releasePolicy } = ok(parseReleasePolicy(md));
    expect(releasePolicy.mystery.release).toBe('never');
  });

  it('returns an empty policy when there is no release block', () => {
    const { releasePolicy } = ok(parseReleasePolicy('---\ntitle: "x"\n---\nbody'));
    expect(releasePolicy).toEqual({});
  });
});

describe('parseReleasePolicy — over-broad / malformed → validation failure', () => {
  it('rejects declaring a discloses-others field `silent` (widens disclosure)', () => {
    const md = [
      '---',
      'release:',
      '  friend_list:',
      '    discloses_others: true',
      '    sensitive: false',
      '    release: silent',
      '---',
    ].join('\n');
    const result = parseReleasePolicy(md);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('friend_list');
      expect(result.error).toContain('widens disclosure');
      expect(result.error).toContain('may only tighten');
    }
  });

  it('rejects an unknown release tier', () => {
    const md = [
      '---',
      'release:',
      '  bio:',
      '    discloses_others: false',
      '    sensitive: false',
      '    release: public',
      '---',
    ].join('\n');
    const result = parseReleasePolicy(md);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('invalid release tier');
  });

  it('rejects an invalid proof_grade', () => {
    const md = [
      '---',
      'release:',
      '  bio:',
      '    discloses_others: false',
      '    sensitive: false',
      '    proof_grade: notarized',
      '---',
    ].join('\n');
    const result = parseReleasePolicy(md);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('invalid proof_grade');
  });

  it('rejects a non-boolean classification axis', () => {
    const md = [
      '---',
      'release:',
      '  bio:',
      '    discloses_others: "yes"',
      '---',
    ].join('\n');
    const result = parseReleasePolicy(md);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('must be a boolean');
  });

  it('rejects a release block that is not a mapping', () => {
    const result = parseReleasePolicy('---\nrelease: "silent"\n---');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('must be a mapping');
  });
});

describe('coexistence with the #1193 article header', () => {
  it('round-trips article fields AND the release policy in one header', () => {
    const article: ArticleBlock = {
      slug: 'hello-world',
      title: 'Hello, World',
      status: 'POSTED',
      date: '2026-06-29',
    };
    // Compose the #1193 article header, then splice a release block into it.
    const articleFile = composeArticleFile(article, '# Body\n\ntext');
    const withRelease = articleFile.replace(
      '---\n\n',
      ['release:', '  title:', '    discloses_others: false', '    sensitive: false', '---', '', ''].join('\n'),
    );
    const parsed = ok(parseReleasePolicy(withRelease));
    // Article truth-data still present alongside the release policy.
    expect(parsed.data.slug).toBe('hello-world');
    expect(parsed.data.title).toBe('Hello, World');
    expect(parsed.data.status).toBe('POSTED');
    expect(parsed.releasePolicy.title.release).toBe('silent');
    expect(parsed.body.trim()).toContain('# Body');
  });
});
