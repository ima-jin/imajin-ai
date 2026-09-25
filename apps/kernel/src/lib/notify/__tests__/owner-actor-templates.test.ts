/**
 * Owner-facing notify templates under the #2366 actor rule.
 *
 * The regression these pin: the projection-request alert read
 * `<owner DID> requested your document.projection · <owner DID> · <scope>` —
 * the owner's own DID twice, with the acting delegate nowhere. Every
 * owner-facing template built from a `{did, appDid}` context now names the
 * delegate and says so, while first-party copy is left exactly as it was.
 */
import { describe, it, expect } from 'vitest';
import { getTemplate } from '../templates';
import { shortenDid } from '../owner-actor';

/** The owner (`sub`) from the reported incident. */
const RYAN = 'did:imajin:88kPzzzzzzzzzzzzzzzzzzzzzzzzzzzzNWXU';
/** The acting app (`azp`) from the reported incident. */
const JIN = 'did:imajin:ADEKzzzzzzzzzzzzzzzzzzzzzzzzzzzzn54k';

/** The exact `data` the broker's consent-request notifier now sends for #2366's case. */
const DELEGATED_PROJECTION = {
  requesterDid: RYAN,
  did: RYAN,
  appDid: JIN,
  purpose: 'document.projection',
  fields: ['moonshot:infer'],
};

describe('broker:consent-request — delegated request (#2366)', () => {
  it('names the acting delegate and says on behalf of you', () => {
    const template = getTemplate('broker:consent-request')!;
    expect(template.title(DELEGATED_PROJECTION)).toBe(
      `${shortenDid(JIN)} requested your document.projection on behalf of you`,
    );
  });

  it('never renders the owner as their own requester', () => {
    const template = getTemplate('broker:consent-request')!;
    expect(template.title(DELEGATED_PROJECTION)).not.toContain(shortenDid(RYAN));
  });

  it('states the acting app DID in the body alongside the requested scope', () => {
    const template = getTemplate('broker:consent-request')!;
    const body = template.body(DELEGATED_PROJECTION);
    expect(body).toContain('moonshot:infer');
    expect(body).toContain(JIN);
  });
});

describe('broker:consent-request — true first-party request', () => {
  it('keeps the existing one-DID title when no delegate acted', () => {
    const template = getTemplate('broker:consent-request')!;
    const data = { requesterDid: RYAN, did: RYAN, purpose: 'document.projection', fields: ['moonshot:infer'] };
    expect(template.title(data)).toBe(`${shortenDid(RYAN)} requested your document.projection`);
    expect(template.body(data)).toBe('Fields requested: moonshot:infer');
  });

  it('renders a legacy payload (requesterDid only) exactly as before', () => {
    const template = getTemplate('broker:consent-request')!;
    expect(template.title({ requesterDid: JIN, purpose: 'profile' })).toBe(
      `${shortenDid(JIN)} requested your profile`,
    );
  });

  it('still falls back to the anonymous label with no identity at all', () => {
    const template = getTemplate('broker:consent-request')!;
    expect(template.title({})).toBe('Someone requested your data');
  });
});

describe('broker:disclosure-receipt', () => {
  it('names the delegate on a delegated disclosure', () => {
    const template = getTemplate('broker:disclosure-receipt')!;
    expect(template.title({ did: RYAN, appDid: JIN, requesterDid: RYAN, purpose: 'profile' })).toBe(
      `${shortenDid(JIN)} accessed your profile on behalf of you`,
    );
  });

  it('keeps the anonymous first-party fallback label', () => {
    const template = getTemplate('broker:disclosure-receipt')!;
    expect(template.title({})).toBe('A party accessed your data');
  });
});

describe('connector lifecycle templates', () => {
  it('keeps the provider-first copy for a first-party seal', () => {
    const template = getTemplate('connector.credential.sealed')!;
    const data = { provider: 'moonshot', did: RYAN };
    expect(template.title(data)).toBe('moonshot credential sealed');
    expect(template.body(data)).toBe('A credential was sealed for the moonshot connector.');
  });

  it('names the delegate when an app sealed the credential for the owner', () => {
    const template = getTemplate('connector.credential.sealed')!;
    const data = { provider: 'moonshot', did: RYAN, appDid: JIN };
    expect(template.title(data)).toBe(
      `${shortenDid(JIN)} sealed your moonshot credential on behalf of you`,
    );
    expect(template.body(data)).toContain(JIN);
  });

  it('names the delegate on an unseal', () => {
    const template = getTemplate('connector.credential.unsealed')!;
    expect(template.title({ provider: 'moonshot', did: RYAN, appDid: JIN })).toBe(
      `${shortenDid(JIN)} unsealed your moonshot credential on behalf of you`,
    );
  });

  it('names the delegate on a model-catalog change', () => {
    const template = getTemplate('connector.models.changed')!;
    expect(template.title({ provider: 'moonshot', did: RYAN, appDid: JIN })).toBe(
      `${shortenDid(JIN)} changed your moonshot model catalog on behalf of you`,
    );
    expect(template.title({ provider: 'moonshot', did: RYAN })).toBe('moonshot model catalog changed');
  });
});
