/**
 * The one definition of "whose Inbox" (#2723): connector proposals go to
 * their owner, everything else to the node operator.
 */
import { describe, expect, it } from 'vitest';
import {
  agentActingForOperatorIdentity,
  CONNECTOR_OWNER_DID,
  githubProposalDetail,
  operatorActingAsGroupIdentity,
  operatorIdentity,
  OPERATOR_DID,
} from './operator-approvals-test-helpers';
import { connectorOwnerDid, inboxDidFor, resolveApprovalAddressee } from '../approval-addressing';

describe('connectorOwnerDid / resolveApprovalAddressee', () => {
  it.each([
    // [label, kind, detail, owner]
    ['github append tier', 'github:append', githubProposalDetail(CONNECTOR_OWNER_DID), CONNECTOR_OWNER_DID],
    ['github mutate tier', 'github:mutate', githubProposalDetail(CONNECTOR_OWNER_DID), CONNECTOR_OWNER_DID],
    ['any other connector write tier', 'google-calendar:write', { ownerDid: CONNECTOR_OWNER_DID }, CONNECTOR_OWNER_DID],
    ['a connector kind with no detail', 'github:mutate', null, null],
    ['a connector kind whose ownerDid is not a DID', 'github:mutate', { ownerDid: 'eric' }, null],
    ['a connector kind whose ownerDid is not a string', 'github:mutate', { ownerDid: 42 }, null],
    ['apps:provision (node-level, even with an ownerDid)', 'apps:provision', { ownerDid: CONNECTOR_OWNER_DID }, null],
    ['a vault proposal', 'vault:mint', { ownerDid: CONNECTOR_OWNER_DID }, null],
    ['a gateway restart', 'system-agent:restart', null, null],
    ['an exec command', 'gateway-exec:command', { ownerDid: CONNECTOR_OWNER_DID }, null],
    ['a decision card', 'decision:card', { ownerDid: CONNECTOR_OWNER_DID }, null],
    ['an access grant', 'access:bearer-grant', { ownerDid: CONNECTOR_OWNER_DID }, null],
    ['a kind that merely contains a tier word', 'github:append-extra', { ownerDid: CONNECTOR_OWNER_DID }, null],
  ])('%s', (_label, kind, detail, owner) => {
    expect(connectorOwnerDid({ kind, detail })).toBe(owner);
    expect(resolveApprovalAddressee({ kind, detail }, OPERATOR_DID)).toBe(owner ?? OPERATOR_DID);
  });
});

describe('inboxDidFor', () => {
  it.each([
    ['a directly authenticated principal', operatorIdentity(), OPERATOR_DID],
    // act-as is refused on the decide rail by `actAsRefusal`; reading still uses the REAL session DID.
    ['an operator session under act-as keeps the real session DID', operatorActingAsGroupIdentity(), OPERATOR_DID],
    ['a delegated agent has no Inbox', agentActingForOperatorIdentity(), null],
  ])('%s', (_label, identity, expected) => {
    expect(inboxDidFor(identity)).toBe(expected);
  });
});
