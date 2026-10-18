/** Shared Inbox actions; deliberately DB-free for signing and rendering. */
export const REACH_MODES = ['reply', 'accept', 'decline', 'block'] as const;

export function isReachApproval(row: { source: string; kind: string }): boolean {
  return (row.source === 'reach' && row.kind === 'reach:message')
    || (row.source === 'knock' && row.kind === 'knock:request');
}

export function validReachReply(mode: string | undefined, message: unknown): boolean {
  return mode === 'reply'
    ? typeof message === 'string' && Boolean(message.trim()) && message.length <= 16_000
    : message === undefined;
}
