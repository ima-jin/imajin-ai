/** Shared list/count/decision policy. No database or server-only imports. */
export interface ApprovalAttention {
  source: string;
  kind: string;
  status: string;
  createdAt: Date | string;
  appliedAt?: Date | string | null;
  archivedAt?: string | null;
  detail?: Record<string, unknown> | null;
  nativeDecision?: boolean;
  sessionBinding?: unknown;
  sessionOutcome?: unknown;
}

const DAY_MS = 86_400_000;
export const DEFAULT_APPROVAL_EXPIRY_DAYS = 7;

/** Invalid configuration fails back to the documented default, never disables expiry. */
export function approvalExpiryDays(value?: string): number {
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_APPROVAL_EXPIRY_DAYS;
}

export function approvalExpiryReason(card: ApprovalAttention, now = Date.now(), days = DEFAULT_APPROVAL_EXPIRY_DAYS): string | null {
  if (!['pending', 'approved'].includes(card.status) || card.appliedAt) return null;
  const sourceDeadline = card.detail?.expiresAt;
  const parsed = typeof sourceDeadline === 'string' ? Date.parse(sourceDeadline) : Number.NaN;
  const fallback = new Date(card.createdAt).getTime() + days * DAY_MS;
  const deadline = Number.isFinite(parsed)
    ? Math.min(parsed, card.status === 'pending' ? fallback : parsed) : fallback;
  if (now < deadline || !Number.isFinite(deadline)) return null;
  return card.status === 'approved' ? 'not applied before approval deadline' : 'pending approval deadline elapsed';
}

export function isApprovalActionable(card: ApprovalAttention, now = Date.now(), days = DEFAULT_APPROVAL_EXPIRY_DAYS): boolean {
  if (card.archivedAt || card.appliedAt || card.sessionOutcome || approvalExpiryReason(card, now, days)) return false;
  if (card.status === 'pending') return true;
  // Approved legacy proposals can still be withdrawn until the source applies them.
  // Decision cards and native commands are already decided, not awaiting another tap.
  return card.status === 'approved' && !card.nativeDecision && !card.sessionBinding
    && !(card.source === 'decision' && card.kind === 'decision:card')
    && !['reach', 'knock'].includes(card.source);
}

export function approvalAge(createdAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
  if (!Number.isFinite(minutes)) return 'age unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m old`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h old`;
  return `${Math.floor(minutes / 1440)}d old`;
}
