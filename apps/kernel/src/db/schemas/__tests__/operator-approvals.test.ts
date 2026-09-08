/**
 * Pins the operator.approvals drizzle table shape (#2059) — column names,
 * defaults, and the schema it lives under. Every other test in this repo
 * mocks `@/src/db`, so this schema definition module (top-level
 * `pgSchema()`/`.table()` calls) is otherwise never executed by any test;
 * this file imports it directly, unmocked, so it counts as covered.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { operatorApprovals, operatorSchema } from '../operator-approvals';

describe('operator.approvals schema', () => {
  it('lives under the operator schema', () => {
    expect(operatorSchema.schemaName).toBe('operator');
  });

  it('maps every column to its snake_case DB name', () => {
    expect(operatorApprovals.proposalId.name).toBe('proposal_id');
    expect(operatorApprovals.operatorDid.name).toBe('operator_did');
    expect(operatorApprovals.kind.name).toBe('kind');
    expect(operatorApprovals.summary.name).toBe('summary');
    expect(operatorApprovals.keysTouched.name).toBe('keys_touched');
    expect(operatorApprovals.notificationId.name).toBe('notification_id');
    expect(operatorApprovals.status.name).toBe('status');
    expect(operatorApprovals.decision.name).toBe('decision');
    expect(operatorApprovals.appliedAt.name).toBe('applied_at');
    expect(operatorApprovals.createdAt.name).toBe('created_at');
    expect(operatorApprovals.updatedAt.name).toBe('updated_at');
  });

  it('proposal_id is the primary key', () => {
    expect(operatorApprovals.proposalId.primary).toBe(true);
  });

  it('defaults status to pending and keysTouched to an empty array', () => {
    expect(operatorApprovals.status.default).toBe('pending');
    expect(operatorApprovals.keysTouched.default).toEqual([]);
  });

  it('requires the not-null columns the lifecycle state machine depends on', () => {
    expect(operatorApprovals.operatorDid.notNull).toBe(true);
    expect(operatorApprovals.kind.notNull).toBe(true);
    expect(operatorApprovals.summary.notNull).toBe(true);
    expect(operatorApprovals.status.notNull).toBe(true);
  });

  it('leaves decision and appliedAt nullable until a decision/apply is recorded', () => {
    expect(operatorApprovals.decision.notNull).toBe(false);
    expect(operatorApprovals.appliedAt.notNull).toBe(false);
  });

  it('declares the operator- and status-scoped lookup indexes', () => {
    const { indexes } = getTableConfig(operatorApprovals);
    const names = indexes.map((index) => index.config.name);
    expect(names).toEqual(['idx_operator_approvals_operator', 'idx_operator_approvals_status']);
  });
});
