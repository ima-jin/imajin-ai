import { describe, expect, it } from 'vitest';
import { isProvisionDomain, isSiteOwnerDid, validateDomainChoice } from '../domain-choice';

describe('shared provision domain choices', () => {
  it.each(['dev-gbs.imajin.ai', 'a.imajin.ai', `${'a'.repeat(63)}.imajin.ai`])('accepts direct host %s', domain => {
    expect(isProvisionDomain(domain)).toBe(true);
    expect(validateDomainChoice({ domain })).toBeNull();
  });
  it.each([null, 42, '', 'imajin.ai', 'nested.dev-gbs.imajin.ai', 'customer.example',
    '-gbs.imajin.ai', 'gbs-.imajin.ai', 'GBS.imajin.ai', 'https://gbs.imajin.ai',
    'gbs.imajin.ai/path', `${'a'.repeat(64)}.imajin.ai`, ' gbs.imajin.ai'])('rejects host %j', domain => {
    expect(isProvisionDomain(domain)).toBe(false);
    expect(validateDomainChoice({ domain })).toBe('domain must be a direct imajin.ai subdomain; custom domains require TXT verification');
  });
  it.each(['did:imajin:gbs', 'did:key:z123:._-', `did:imajin:${'a'.repeat(200)}`])('accepts DID %s', siteOwnerDid => {
    expect(isSiteOwnerDid(siteOwnerDid)).toBe(true);
    expect(validateDomainChoice({ siteOwnerDid })).toBeNull();
  });
  it.each([null, 42, '', '@gbs', 'not-a-did', 'did:imajin:', 'did:IMAJIN:gbs',
    'did:imajin:gbs/extra', `did:imajin:${'a'.repeat(201)}`])('rejects DID %j', siteOwnerDid => {
    expect(isSiteOwnerDid(siteOwnerDid)).toBe(false);
    expect(validateDomainChoice({ siteOwnerDid })).toBe('siteOwnerDid must be a DID');
  });
  it('allows missing choices and a bare claim reissue', () => {
    expect(validateDomainChoice({})).toBeNull();
    expect(validateDomainChoice({ reissueClaim: true })).toBeNull();
  });
  it.each(['public', 'private', 'unlisted', 'internal'])('preserves API visibility %s', visibility => {
    expect(validateDomainChoice({ visibility })).toBeNull();
  });
  it('preserves audience and visibility validation precedence', () => {
    expect(validateDomainChoice({ signInAudience: 'bad', visibility: 'bad' })).toContain('signInAudience');
    expect(validateDomainChoice({ visibility: 'bad', domain: 'bad' })).toContain('visibility');
    expect(validateDomainChoice({ siteOwnerDid: 'bad', domain: 'bad' })).toBe('siteOwnerDid must be a DID');
  });
  it.each(['siteOwnerDid', 'domain', 'visibility'])('refuses reissue choice %s', field => {
    const choices = { siteOwnerDid: 'did:imajin:gbs', domain: 'dev-gbs.imajin.ai', visibility: 'private' };
    expect(validateDomainChoice({ reissueClaim: true, [field]: choices[field as keyof typeof choices] }))
      .toBe('Reissuing a claim cannot change ownership, domain or visibility');
  });
  it('preserves own-property and repository checks on reissues', () => {
    expect(validateDomainChoice({ reissueClaim: true, signInAudience: undefined })).toBe('Reissuing a claim cannot change signInAudience');
    expect(validateDomainChoice({ reissueClaim: true, sourceRepo: undefined })).toBe('Reissuing a claim cannot change sourceRepo');
    expect(validateDomainChoice({ sourceRepo: 'bad' })).toBe('sourceRepo must be an owner/name repository identifier');
    expect(validateDomainChoice({ sourceRepo: 'gbscontracting/website', signInAudience: 'members' })).toBeNull();
  });
});
