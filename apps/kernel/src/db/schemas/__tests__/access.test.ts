/**
 * Pins the auth.delegate_grant_requests / auth.delegate_grant_bearers
 * drizzle table shapes (#2252) — column names, defaults, and the schema
 * they live under. Every other test in this repo mocks `@/src/db`, so
 * this schema definition module (top-level `pgSchema()`/`.table()` calls)
 * is otherwise never executed by any test; this file imports it directly,
 * unmocked, so it counts as covered (mirrors
 * `./operator-approvals.test.ts`'s rationale).
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { accessSchema, delegateGrantRequests, delegateGrantBearers } from '../access';

describe('delegate-grant schema (#2252)', () => {
  it('lives under the auth schema', () => {
    expect(accessSchema.schemaName).toBe('auth');
  });

  describe('delegate_grant_requests (the KNOCK)', () => {
    it('maps every column to its snake_case DB name', () => {
      expect(delegateGrantRequests.id.name).toBe('id');
      expect(delegateGrantRequests.principalDid.name).toBe('principal_did');
      expect(delegateGrantRequests.clientLabel.name).toBe('client_label');
      expect(delegateGrantRequests.purpose.name).toBe('purpose');
      expect(delegateGrantRequests.scopes.name).toBe('scopes');
      expect(delegateGrantRequests.surfaces.name).toBe('surfaces');
      expect(delegateGrantRequests.slidingWindowDays.name).toBe('sliding_window_days');
      expect(delegateGrantRequests.status.name).toBe('status');
      expect(delegateGrantRequests.approvalId.name).toBe('approval_id');
      expect(delegateGrantRequests.createdAt.name).toBe('created_at');
      expect(delegateGrantRequests.decidedAt.name).toBe('decided_at');
      expect(delegateGrantRequests.expiresAt.name).toBe('expires_at');
    });

    it('id is the primary key', () => {
      expect(delegateGrantRequests.id.primary).toBe(true);
    });

    it('defaults status to pending and sliding_window_days to 90', () => {
      expect(delegateGrantRequests.status.default).toBe('pending');
      expect(delegateGrantRequests.slidingWindowDays.default).toBe(90);
    });

    it('requires the not-null columns the knock lifecycle depends on', () => {
      expect(delegateGrantRequests.principalDid.notNull).toBe(true);
      expect(delegateGrantRequests.clientLabel.notNull).toBe(true);
      expect(delegateGrantRequests.purpose.notNull).toBe(true);
      expect(delegateGrantRequests.status.notNull).toBe(true);
      expect(delegateGrantRequests.expiresAt.notNull).toBe(true);
    });

    it('leaves approvalId and decidedAt nullable (unset until the card is raised/decided)', () => {
      expect(delegateGrantRequests.approvalId.notNull).toBe(false);
      expect(delegateGrantRequests.decidedAt.notNull).toBe(false);
    });

    it('declares the principal- and approval-scoped lookup indexes', () => {
      const { indexes } = getTableConfig(delegateGrantRequests);
      const names = indexes.map((index) => index.config.name);
      expect(names).toEqual(['idx_delegate_grant_requests_principal', 'idx_delegate_grant_requests_approval']);
    });
  });

  describe('delegate_grant_bearers (the credential + the relation)', () => {
    it('maps every column to its snake_case DB name', () => {
      expect(delegateGrantBearers.id.name).toBe('id');
      expect(delegateGrantBearers.requestId.name).toBe('request_id');
      expect(delegateGrantBearers.principalDid.name).toBe('principal_did');
      expect(delegateGrantBearers.clientLabel.name).toBe('client_label');
      expect(delegateGrantBearers.purpose.name).toBe('purpose');
      expect(delegateGrantBearers.scopes.name).toBe('scopes');
      expect(delegateGrantBearers.surfaces.name).toBe('surfaces');
      expect(delegateGrantBearers.tokenHash.name).toBe('token_hash');
      expect(delegateGrantBearers.slidingWindowDays.name).toBe('sliding_window_days');
      expect(delegateGrantBearers.issuedAt.name).toBe('issued_at');
      expect(delegateGrantBearers.lastUsedAt.name).toBe('last_used_at');
      expect(delegateGrantBearers.expiresAt.name).toBe('expires_at');
      expect(delegateGrantBearers.hardCapAt.name).toBe('hard_cap_at');
      expect(delegateGrantBearers.status.name).toBe('status');
      expect(delegateGrantBearers.approvalId.name).toBe('approval_id');
      expect(delegateGrantBearers.revokedAt.name).toBe('revoked_at');
      expect(delegateGrantBearers.revokedBy.name).toBe('revoked_by');
      expect(delegateGrantBearers.createdAt.name).toBe('created_at');
    });

    it('id is the primary key and requestId references delegate_grant_requests', () => {
      expect(delegateGrantBearers.id.primary).toBe(true);
      expect(getTableConfig(delegateGrantBearers).foreignKeys).toHaveLength(1);
    });

    it('defaults status to active and sliding_window_days to 90', () => {
      expect(delegateGrantBearers.status.default).toBe('active');
      expect(delegateGrantBearers.slidingWindowDays.default).toBe(90);
    });

    it('requires the not-null columns the credential lifecycle depends on, including approvalId', () => {
      expect(delegateGrantBearers.requestId.notNull).toBe(true);
      expect(delegateGrantBearers.principalDid.notNull).toBe(true);
      expect(delegateGrantBearers.expiresAt.notNull).toBe(true);
      expect(delegateGrantBearers.hardCapAt.notNull).toBe(true);
      expect(delegateGrantBearers.status.notNull).toBe(true);
      expect(delegateGrantBearers.approvalId.notNull).toBe(true);
    });

    it('leaves tokenHash, lastUsedAt, revokedAt, and revokedBy nullable (tokenHash is erased on revoke)', () => {
      expect(delegateGrantBearers.tokenHash.notNull).toBe(false);
      expect(delegateGrantBearers.lastUsedAt.notNull).toBe(false);
      expect(delegateGrantBearers.revokedAt.notNull).toBe(false);
      expect(delegateGrantBearers.revokedBy.notNull).toBe(false);
    });

    it('declares a unique index on tokenHash and the principal/request lookup indexes', () => {
      const { indexes } = getTableConfig(delegateGrantBearers);
      const byName = Object.fromEntries(indexes.map((index) => [index.config.name, index]));
      expect(byName.uniq_delegate_grant_bearers_token_hash?.config.unique).toBe(true);
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining([
          'uniq_delegate_grant_bearers_token_hash',
          'idx_delegate_grant_bearers_principal',
          'idx_delegate_grant_bearers_request',
        ]),
      );
    });
  });
});
