/**
 * In-memory `WithdrawRail` test double (#2172).
 *
 * Used by every withdraw-intent/reconciler test so none of them ever touch
 * Stripe types — proving the kernel path is genuinely rail-agnostic, not
 * just typed against an interface that only one implementation exists for.
 *
 * Not a `.test.ts` file, so vitest's `apps/**\/__tests__/**\/*.test.ts`
 * include glob does not pick this up as a test suite of its own.
 */
import type {
  WithdrawRail,
  WithdrawalIntent,
  WithdrawRailExecuteResult,
  ListTransfersParams,
  RailTransfer,
} from '../rails/types';

export interface FakeRailOptions {
  name?: string;
  /** When set, every `execute()` call rejects with this error instead of succeeding. */
  failWith?: Error;
}

/**
 * Records every `execute()` call keyed by `idempotencyKey`. A second call
 * with a key already seen returns the SAME synthetic `externalRef` instead
 * of minting a new one — the same idempotency contract `StripeWithdrawRail`
 * gives Stripe's real `idempotencyKey`, so a retry-with-same-intent test
 * can assert "exactly one transfer" purely by counting distinct external
 * refs rather than needing a real Stripe mock.
 */
export class FakeRail implements WithdrawRail {
  readonly name: string;
  readonly executeCalls: WithdrawalIntent[] = [];
  private readonly transfersByIdempotencyKey = new Map<string, WithdrawRailExecuteResult>();
  private readonly listedTransfers: RailTransfer[] = [];
  private nextRefSeq = 1;
  private failWith?: Error;

  constructor(opts: FakeRailOptions = {}) {
    this.name = opts.name ?? 'fake';
    this.failWith = opts.failWith;
  }

  /** Test control: make the next (and every subsequent) `execute()` call throw. */
  setFailure(err: Error | undefined): void {
    this.failWith = err;
  }

  /** Test control: seed a transfer `list()` will report, independent of any `execute()` call (e.g. to simulate an external-without-ledger discrepancy). */
  seedTransfer(transfer: RailTransfer): void {
    this.listedTransfers.push(transfer);
  }

  async execute(intent: WithdrawalIntent): Promise<WithdrawRailExecuteResult> {
    this.executeCalls.push(intent);

    if (this.failWith) {
      throw this.failWith;
    }

    const existing = this.transfersByIdempotencyKey.get(intent.idempotencyKey);
    if (existing) return existing;

    const result: WithdrawRailExecuteResult = { externalRef: `fake_tr_${this.nextRefSeq++}` };
    this.transfersByIdempotencyKey.set(intent.idempotencyKey, result);
    this.listedTransfers.push({
      externalRef: result.externalRef,
      intentId: intent.id,
      amount: Number.parseFloat(intent.amount),
      unit: intent.unit,
      createdAt: new Date(),
    });
    return result;
  }

  async list({ since }: ListTransfersParams): Promise<RailTransfer[]> {
    return this.listedTransfers.filter((t) => t.createdAt >= since);
  }

  async confirmFromEvent(payload: unknown): Promise<{ intentId: string; externalRef: string } | null> {
    if (!payload || typeof payload !== 'object') return null;
    const event = payload as { type?: unknown; intentId?: unknown; externalRef?: unknown };
    if (event.type !== 'fake.transfer.created') return null;
    if (typeof event.intentId !== 'string' || typeof event.externalRef !== 'string') return null;
    return { intentId: event.intentId, externalRef: event.externalRef };
  }

  /** Distinct external transfer refs actually minted — the "exactly one real transfer" assertion for retry tests. */
  get distinctExternalRefs(): string[] {
    return [...this.transfersByIdempotencyKey.values()].map((r) => r.externalRef);
  }
}
