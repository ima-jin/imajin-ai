/**
 * #1582 — the pending-approval copy told the agent to "Approve at
 * /github/api/confirm/<id>". That is a POST + owner-DID-auth API; the first
 * external user's client relayed it verbatim, he opened it in a browser, and
 * got a 405. These tests pin the three properties that failure demands:
 * `/jin` is named as the human door, the URL is fully qualified, and the
 * confirm path is labelled an API rather than somewhere to click.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pendingApprovalMessage } from '../pending-message';

const ENV_KEYS = [
  'APP_URL',
  'NEXT_PUBLIC_BASE_URL',
  'NEXT_PUBLIC_SERVICE_PREFIX',
  'NEXT_PUBLIC_DOMAIN',
] as const;

const PROPOSAL_ID = 'proposal_PJxmjcx-abc123';

beforeEach(() => {
  // Clear first so each test exercises the branch it configures. stubEnv
  // records the original for unstubAllEnvs; the delete is what unsets it.
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, '');
    delete process.env[key];
  }
  vi.stubEnv('APP_URL', 'https://jin.imajin.ai');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pendingApprovalMessage — points the human at /jin', () => {
  it('names the /jin dashboard as the approval surface', () => {
    expect(pendingApprovalMessage(PROPOSAL_ID)).toContain('https://jin.imajin.ai/jin');
  });

  it('still reports the proposalId so the row can be found', () => {
    expect(pendingApprovalMessage(PROPOSAL_ID)).toContain(PROPOSAL_ID);
  });

  /**
   * The old copy's exact failure mode: "Approve at <confirm path>" reads to an
   * LLM as a clickable page, so the agent sends the human to a 405.
   */
  it('never frames the confirm path as somewhere to approve', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID);
    expect(message).not.toMatch(/approv\w*\s+at\s+\S*\/github\/api\/confirm/i);
  });

  it('labels the confirm path as a POST API, not a page', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID);
    expect(message).toContain(`POST https://jin.imajin.ai/github/api/confirm/${PROPOSAL_ID}`);
    expect(message).toMatch(/not a page/i);
  });

  /**
   * The reporting user had 11 queued writes. "Approve once with 24h" is the
   * intended flow, and an agent that is never told the windows exist will walk
   * the human through eleven separate approvals.
   */
  it('surfaces the TTL windows so a batch can be approved once', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID);
    expect(message).toContain('5m');
    expect(message).toContain('24h');
  });

  it('tells the caller to retry the tool call after approval', () => {
    expect(pendingApprovalMessage(PROPOSAL_ID)).toMatch(/retry this tool call/i);
  });
});

describe('pendingApprovalMessage — host resolution', () => {
  /**
   * The message crosses into a remote MCP client with no idea which node it is
   * talking to, so a bare `/jin` leaves the agent guessing a host — which is
   * exactly what happened in the first-user report.
   */
  it('emits absolute URLs, never a bare path', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID);
    expect(message).not.toMatch(/(^|[\s(])\/jin\b/);
    expect(message).not.toMatch(/(^|[\s(])\/github\/api\/confirm/);
  });

  it('tracks the configured origin rather than hard-coding one', () => {
    vi.stubEnv('APP_URL', 'https://dev-jin.imajin.ai');
    expect(pendingApprovalMessage(PROPOSAL_ID)).toContain('https://dev-jin.imajin.ai/jin');
  });

  it('falls back to NEXT_PUBLIC_BASE_URL when APP_URL is unset', () => {
    vi.stubEnv('APP_URL', '');
    delete process.env.APP_URL;
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'http://localhost:3000');
    expect(pendingApprovalMessage(PROPOSAL_ID)).toContain('http://localhost:3000/jin');
  });

  it('never doubles a slash between the origin and the path', () => {
    vi.stubEnv('APP_URL', 'https://jin.imajin.ai/');
    const message = pendingApprovalMessage(PROPOSAL_ID);
    expect(message).toContain('https://jin.imajin.ai/jin');
    expect(message).not.toContain('.ai//');
  });
});

/**
 * #1716 — a write that re-proposes because a rate ceiling tripped (even though
 * a live approval window is already active) must NOT read like the generic
 * "no window yet" copy. Conflating the two is exactly what made repeat
 * approvals look like they "did nothing": the human kept re-approving a
 * window that was never the problem.
 */
describe('pendingApprovalMessage — rate_limited reason (#1716)', () => {
  it('defaults to the no_grant copy when reason is omitted', () => {
    expect(pendingApprovalMessage(PROPOSAL_ID)).toContain('This write is held pending your approval');
  });

  it('states plainly that an approval window is already active', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID, 'rate_limited', '5/hr');
    expect(message).toMatch(/approval window is already active/i);
    expect(message).toMatch(/NOT a missing-approval/i);
  });

  it('tells the caller approving again will not help', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID, 'rate_limited', '5/hr');
    expect(message).toMatch(/will\s+NOT let the write through any sooner/i);
  });

  it('includes the limit label that tripped when provided', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID, 'rate_limited', '5/hr');
    expect(message).toContain('5/hr');
  });

  it('tolerates a null limit label', () => {
    expect(() => pendingApprovalMessage(PROPOSAL_ID, 'rate_limited', null)).not.toThrow();
  });

  it('tells the caller to just wait and retry rather than re-approve', () => {
    const message = pendingApprovalMessage(PROPOSAL_ID, 'rate_limited', '5/hr');
    expect(message).toMatch(/wait/i);
    expect(message).toMatch(/retry the same tool/i);
  });
});
