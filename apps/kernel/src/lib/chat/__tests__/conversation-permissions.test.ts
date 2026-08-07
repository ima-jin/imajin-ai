/**
 * canDeleteConversation (#1651).
 *
 * The UI gate has to agree with the API gate exactly: `DELETE
 * /chat/api/conversations/:id` 403s unless `conv.createdBy === effectiveDid`.
 * Anything looser puts a button in front of a user that cannot work; anything
 * stricter hides the creator's own control.
 */
import { describe, it, expect } from 'vitest';
import { canDeleteConversation } from '../conversation-permissions';

const CREATOR = 'did:imajin:alice';
const OTHER = 'did:imajin:bob';

describe('canDeleteConversation', () => {
  it('lets the creator delete', () => {
    expect(canDeleteConversation({ createdBy: CREATOR }, CREATOR)).toBe(true);
  });

  it('refuses a participant who did not create the conversation', () => {
    expect(canDeleteConversation({ createdBy: CREATOR }, OTHER)).toBe(false);
  });

  it('refuses an anonymous viewer', () => {
    expect(canDeleteConversation({ createdBy: CREATOR }, null)).toBe(false);
    expect(canDeleteConversation({ createdBy: CREATOR }, undefined)).toBe(false);
    expect(canDeleteConversation({ createdBy: CREATOR }, '')).toBe(false);
  });

  it('refuses when the conversation has no recorded creator', () => {
    expect(canDeleteConversation({ createdBy: null }, CREATOR)).toBe(false);
    expect(canDeleteConversation({}, CREATOR)).toBe(false);
  });

  it('refuses when there is no conversation at all', () => {
    expect(canDeleteConversation(null, CREATOR)).toBe(false);
    expect(canDeleteConversation(undefined, CREATOR)).toBe(false);
  });

  it('does not treat two absent DIDs as a match', () => {
    // Guards the naive `a === b` implementation: two undefined values are equal
    // in JS, which would hand every anonymous visitor a delete button on every
    // creator-less conversation.
    expect(canDeleteConversation({ createdBy: undefined }, undefined)).toBe(false);
  });

  it('is case- and whitespace-sensitive, like the SQL comparison', () => {
    expect(canDeleteConversation({ createdBy: CREATOR }, CREATOR.toUpperCase())).toBe(false);
    expect(canDeleteConversation({ createdBy: CREATOR }, ` ${CREATOR}`)).toBe(false);
  });
});
