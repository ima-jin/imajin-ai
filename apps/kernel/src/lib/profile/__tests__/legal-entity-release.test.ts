import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({ broker: vi.fn() }));
vi.mock('@imajin/bus', () => ({ broker: h.broker, isBrokerRelease: (value: { status: string }) => value.status === 'released' }));
import { releaseLegalEntity, LEGAL_ENTITY_DISCLOSURE_PURPOSE } from '../legal-entity-release';
import { composeLegalEntity, parseLegalEntity } from '../legal-entity-document';
import { LEGAL_ENTITY_FIELDS } from '../legal-entity-schema';
import { legalEntityFixture, ownerDid, viewerDid } from './legal-entity-fixture';
beforeEach(() => {
  h.broker.mockReset().mockResolvedValue({ status: 'rejected' });
});
function setup() {
  const input = legalEntityFixture();
  input.visibility.legalName = 'on-consent';
  input.visibility.operatingName = 'never';
  for (const field of LEGAL_ENTITY_FIELDS.filter(f => f.startsWith('address.'))) input.visibility[field] = 'public';
  const parsed = parseLegalEntity(composeLegalEntity(ownerDid, input), ownerDid);
  return { input, policy: parsed.releasePolicy };
}
describe('legal entity per-field release', () => {
  it.each([null, viewerDid, ownerDid])('never leaks gated fields to %s, even the owner', async viewer => {
    const { input, policy } = setup();
    expect(await releaseLegalEntity(ownerDid, viewer, input, policy)).toEqual({ address: input.address });
  });
  it('allows the reverse arrangement: public name but gated address', async () => {
    const input = legalEntityFixture();
    input.visibility.legalName = 'public';
    input.visibility.operatingName = 'never';
    const { releasePolicy } = parseLegalEntity(composeLegalEntity(ownerDid, input), ownerDid);
    expect(await releaseLegalEntity(ownerDid, viewerDid, input, releasePolicy)).toEqual({ legalName: input.legalName });
  });
  it('releases only explicitly raw-consented fields, using broker output, not source substitution', async () => {
    const { input, policy } = setup();
    h.broker.mockResolvedValue({ status: 'released', enforced: true, data: { legalName: 'Broker result' }, envelope: { fieldModes: { legalName: 'raw' } } });
    expect(await releaseLegalEntity(ownerDid, viewerDid, input, policy)).toEqual({ legalName: 'Broker result', address: input.address });
    expect(h.broker).toHaveBeenCalledWith('legal-entity.field.request', expect.objectContaining({
      requester: viewerDid, subject: ownerDid, purpose: LEGAL_ENTITY_DISCLOSURE_PURPOSE, fields: ['legalName'],
    }));
  });
  it.each([
    { status: 'rejected' },
    { status: 'released', data: { legalName: { attested: true } }, envelope: { mode: 'attestation' } },
    { status: 'released', data: { legalName: 'must not leak' }, envelope: { mode: 'attestation' } },
    { status: 'released', enforced: false, data: { legalName: 'shadow' }, envelope: { mode: 'raw' } },
    { status: 'released', data: {}, envelope: { mode: 'raw' } },
    { status: 'released', data: { legalName: 'must not leak' }, envelope: {} },
  ])('withholds non-releasing consent response %#', async response => {
    const { input, policy } = setup();
    h.broker.mockResolvedValue(response);
    expect(await releaseLegalEntity(ownerDid, viewerDid, input, policy)).toEqual({ address: input.address });
  });
  it('fails closed on broker errors and grant revocation, without cached decisions', async () => {
    const { input, policy } = setup();
    h.broker.mockResolvedValueOnce({ status: 'released', data: { legalName: input.legalName }, envelope: { mode: 'raw' } })
      .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ status: 'rejected' });
    expect((await releaseLegalEntity(ownerDid, viewerDid, input, policy)).legalName).toBe(input.legalName);
    expect((await releaseLegalEntity(ownerDid, viewerDid, input, policy)).legalName).toBeUndefined();
    expect((await releaseLegalEntity(ownerDid, viewerDid, input, policy)).legalName).toBeUndefined();
  });
  it('enforces viewer restrictions, absent rules, owner-only, and absent optional values', async () => {
    const { input, policy } = setup();
    policy['address.line1'].viewer = 'another-viewer';
    delete policy['address.city'];
    policy['address.region'].release = 'owner-only';
    delete input.address.line2;
    const result = await releaseLegalEntity(ownerDid, viewerDid, input, policy);
    expect(result).toEqual({ address: { postalCode: input.address.postalCode, country: 'CA' } });
  });
});
