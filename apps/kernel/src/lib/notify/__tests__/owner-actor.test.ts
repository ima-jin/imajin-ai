/**
 * The canonical owner-facing actor/principal renderer (#2366).
 *
 * The rule under test: an owner alert names the ACTING party, and says
 * "on behalf of you" exactly when a delegate (`appDid`) acted as the principal
 * (`did`). A true first-party request keeps its original one-DID form.
 */
import { describe, it, expect } from 'vitest';
import { ownerActionTitle, ownerActorSentence, resolveOwnerActor, shortenDid } from '../owner-actor';

const RYAN = 'did:imajin:88kPzzzzzzzzzzzzzzzzzzzzzzzzzzzzNWXU';
const JIN = 'did:imajin:ADEKzzzzzzzzzzzzzzzzzzzzzzzzzzzzn54k';

describe('shortenDid', () => {
  it('elides the middle of a long DID', () => {
    const short = shortenDid(RYAN);
    expect(short).toBe('did:imajin:88kPzzzzz\u2026zzNWXU');
    expect(short.length).toBeLessThan(RYAN.length);
  });

  it('leaves a short value untouched', () => {
    expect(shortenDid('did:imajin:jin')).toBe('did:imajin:jin');
    expect(shortenDid('')).toBe('');
  });
});

describe('resolveOwnerActor', () => {
  it('names the delegate and flags on-behalf-of when appDid differs from did', () => {
    const actor = resolveOwnerActor({ did: RYAN, appDid: JIN, requesterDid: RYAN });
    expect(actor.onBehalfOfOwner).toBe(true);
    expect(actor.actorDid).toBe(JIN);
    expect(actor.principalDid).toBe(RYAN);
    expect(actor.label).toBe(shortenDid(JIN));
  });

  it('stays first-party when the principal acted directly', () => {
    const actor = resolveOwnerActor({ did: RYAN, appDid: RYAN, requesterDid: RYAN });
    expect(actor.onBehalfOfOwner).toBe(false);
    expect(actor.actorDid).toBe(RYAN);
  });

  it('stays first-party when no delegate is named at all', () => {
    const actor = resolveOwnerActor({ did: RYAN, requesterDid: RYAN });
    expect(actor.onBehalfOfOwner).toBe(false);
    expect(actor.actorDid).toBe(RYAN);
  });

  it('treats a distinct third-party requester as the actor, but NOT as on-behalf-of', () => {
    const actor = resolveOwnerActor({ did: RYAN, requesterDid: JIN });
    expect(actor.onBehalfOfOwner).toBe(false);
    expect(actor.actorDid).toBe(JIN);
  });

  it('resolves a legacy payload carrying only requesterDid exactly as before', () => {
    const actor = resolveOwnerActor({ requesterDid: JIN });
    expect(actor.onBehalfOfOwner).toBe(false);
    expect(actor.label).toBe(shortenDid(JIN));
  });

  it('prefers a human label over the acting DID', () => {
    const actor = resolveOwnerActor({ did: RYAN, appDid: JIN, actorLabel: 'Jin' });
    expect(actor.label).toBe('Jin');
    expect(actor.actorDid).toBe(JIN);
  });

  it('falls back to the caller-supplied anonymous label when nobody identified themselves', () => {
    expect(resolveOwnerActor({}).label).toBe('Someone');
    expect(resolveOwnerActor({}, 'A party').label).toBe('A party');
  });

  it('ignores non-string and whitespace-only context fields', () => {
    const actor = resolveOwnerActor({ did: RYAN, appDid: '   ', actorLabel: 42 });
    expect(actor.onBehalfOfOwner).toBe(false);
    expect(actor.label).toBe(shortenDid(RYAN));
  });
});

describe('ownerActorSentence / ownerActionTitle', () => {
  it('renders the issue #2366 acceptance form for a delegated request', () => {
    const title = ownerActionTitle(
      { did: RYAN, appDid: JIN, requesterDid: RYAN },
      'requested your document.projection',
    );
    expect(title).toBe(`${shortenDid(JIN)} requested your document.projection on behalf of you`);
  });

  it('keeps the one-DID form for a true first-party request', () => {
    const title = ownerActionTitle({ did: RYAN, requesterDid: RYAN }, 'requested your document.projection');
    expect(title).toBe(`${shortenDid(RYAN)} requested your document.projection`);
    expect(title).not.toContain('on behalf of');
  });

  it('never renders the principal as its own delegate', () => {
    const title = ownerActionTitle({ did: RYAN, appDid: JIN, requesterDid: RYAN }, 'requested your data');
    expect(title.startsWith(shortenDid(RYAN))).toBe(false);
  });

  it('composes from an already-resolved actor', () => {
    const actor = resolveOwnerActor({ did: RYAN, appDid: JIN });
    expect(ownerActorSentence(actor, 'accessed your data')).toContain('on behalf of you');
  });
});
