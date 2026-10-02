/**
 * #2439 — FairAccordion names the remittance authority ("collected for CRA"),
 * not the jurisdiction code ("CA-ON"), matching what #2419 specifies.
 */
import { describe, it, expect } from 'vitest';
import { AUTHORITY_DID_CA_CRA, authorityLabel } from '../src/constants';
import { taxLineLabel } from '../src/taxLabel';

describe('authorityLabel', () => {
  it('maps the well-known CRA authority DID to "CRA"', () => {
    expect(authorityLabel(AUTHORITY_DID_CA_CRA)).toBe('CRA');
  });

  it('upper-cases the slug of any other did:imajin:authority:* DID', () => {
    expect(authorityLabel('did:imajin:authority:ca-qc-rq')).toBe('CA-QC-RQ');
  });

  it('returns null for a DID that is not an authority DID', () => {
    expect(authorityLabel('did:imajin:seller')).toBeNull();
  });

  it('returns null for an authority prefix with no slug', () => {
    expect(authorityLabel('did:imajin:authority:')).toBeNull();
  });
});

describe('taxLineLabel', () => {
  const ROW = { kind: 'GST/HST', rateBps: 1300, jurisdiction: 'CA-ON', remitTo: AUTHORITY_DID_CA_CRA };

  it('shows the authority (CRA), not the jurisdiction code', () => {
    const label = taxLineLabel(ROW);
    expect(label).toBe('GST/HST 13.00% (collected for CRA)');
    expect(label).not.toContain('CA-ON');
  });

  it('falls back to the jurisdiction when remitTo is not an authority DID', () => {
    expect(taxLineLabel({ ...ROW, remitTo: 'did:imajin:someone' })).toBe('GST/HST 13.00% (collected for CA-ON)');
  });
});
