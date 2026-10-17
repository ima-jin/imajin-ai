import { describe, expect, it } from 'vitest';
import { isRepositoryName, validateTemplateLineage, validateTemplateSyncReport } from '../template-lineage';
import { isKnownScope, serviceEligibleScopes } from '@imajin/auth/scope-vocabulary';

describe('template lineage validation', () => {
  it.each(['ima-jin/imajin-app-template', 'gbscontracting/website', 'a/repo.name_1'])('accepts %s without an org allowlist', (repo) => {
    expect(isRepositoryName(repo)).toBe(true);
    expect(validateTemplateLineage({ sourceRepo: repo, template: repo })).toEqual({ ok: { sourceRepo: repo, template: repo } });
  });
  it.each([null, 123, '', 'org', 'org/repo/path', 'https://github.com/org/repo', 'org/..', '-org/repo', 'org/repo?token=x', 'org/repo\n'])('rejects malformed repo %s', (repo) => {
    expect(isRepositoryName(repo)).toBe(false);
  });
  it('distinguishes omitted, cleared, false and unknown history', () => {
    expect(validateTemplateLineage({})).toEqual({ ok: {} });
    expect(validateTemplateLineage({ sourceRepo: null, template: null, templateRef: null, templateSyncedAt: null, joined: false }))
      .toEqual({ ok: { sourceRepo: null, template: null, templateRef: null, templateSyncedAt: null, joined: false } });
    expect(validateTemplateLineage({ templateRef: 'v1.2.3', templateSyncedAt: '2026-10-17T17:00:00Z', joined: true }))
      .toEqual({ ok: { templateRef: 'v1.2.3', templateSyncedAt: new Date('2026-10-17T17:00:00Z'), joined: true } });
  });
  it.each([
    { sourceRepo: 'bad' }, { template: 'bad' }, { joined: 'true' },
    { templateRef: '' }, { templateRef: 23 }, { templateRef: 'x'.repeat(256) },
    { templateSyncedAt: 'yesterday' }, { templateSyncedAt: 123 }, { templateSyncedAt: '2026-99-99T00:00:00Z' },
  ])('rejects invalid metadata %j', (body) => {
    expect(validateTemplateLineage(body)).toHaveProperty('error');
  });
  it('requires both sync fields, disallows routing edits, and validates reports', () => {
    for (const body of [{}, { templateRef: 'v1' }, { templateRef: null, templateSyncedAt: null }, { sourceRepo: 'evil/repo' }]) {
      expect(validateTemplateSyncReport(body)).toHaveProperty('error');
    }
    expect(validateTemplateSyncReport({ templateRef: 'v1', templateSyncedAt: '2026-10-17T00:00:00Z' }))
      .toEqual({ ok: { templateRef: 'v1', templateSyncedAt: new Date('2026-10-17T00:00:00Z') } });
  });
  it('keeps private inventory reads operator-approved, never self-service eligible', () => {
    expect(isKnownScope('registry:template-read')).toBe(true);
    expect(serviceEligibleScopes()).not.toContain('registry:template-read');
  });
});
