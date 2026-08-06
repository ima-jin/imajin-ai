/**
 * Shared `WarpAgentRun` fixture (#1639).
 *
 * `WarpAgentRun` grew from 5 fields to ~25 when the run parse was expanded, and
 * every route test that stubs `getAgentRun` has to satisfy the whole type. A
 * factory keeps that in one place, so the next field added to the parse is one
 * edit here rather than one edit per test file.
 *
 * Lives under `__tests__/` so it is neither collected as a suite (the vitest
 * `include` matches `*.test.ts`) nor counted as production code by coverage.
 */
import type { WarpAgentRun } from '../dispatch';

/** A SUCCEEDED run with everything optional left null, overridable per test. */
export function makeAgentRun(overrides: Partial<WarpAgentRun> = {}): WarpAgentRun {
  return {
    runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
    state: 'SUCCEEDED',
    sessionLink: 'https://app.warp.dev/session/abc',
    title: null,
    configName: 'veteze-jin',
    createdAt: null,
    updatedAt: null,
    startedAt: null,
    runTime: null,
    statusMessage: null,
    source: null,
    executionLocation: null,
    sessionId: null,
    conversationId: null,
    parentRunId: null,
    triggerUrl: null,
    isSandboxRunning: null,
    requestUsage: null,
    creator: null,
    executor: null,
    modelId: null,
    environmentId: null,
    skillSpec: null,
    agentSkill: null,
    schedule: null,
    artifacts: [],
    ...overrides,
  };
}
