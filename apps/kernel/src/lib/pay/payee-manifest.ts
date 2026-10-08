/**
 * Payee-manifest verification for app-authenticated settlement (#2642).
 *
 * An app-authenticated checkout records the payee manifest the app declared
 * (`pay.transactions.payee_manifest`). When the app later settles, the kernel
 * does NOT trust the `fair_manifest` it posts: the posted chain must be exactly
 * the recorded payees — same DIDs, same roles, same amounts — and nothing else.
 *
 * Recorded shapes accepted (checkout stores whatever the app declared; anything
 * else fails closed):
 *   - `chain[]` entries with a dollar `amount`, or a fractional `share` (0..1)
 *     of the payment total — the share-based shape `/pay/api/checkout`'s
 *     `fairManifest` already uses;
 *   - tax rows as `taxCredits[]` (dollars, settle shape) or `taxes[]`
 *     (checkout shape: integer cents, `collectorDid`).
 *
 * Pure (no DB) so it is unit-testable on its own.
 */

/** Per-entry amount tolerance in dollars — the same one-cent slack `validateChain` allows on the sum. */
const AMOUNT_TOLERANCE = 0.01;

interface ExpectedPayee {
  did: string;
  role: string;
  amount: number;
}

interface ExpectedTax {
  did: string;
  jurisdiction: string;
  kind: string;
  amount: number;
}

type Rows = Array<Record<string, unknown>>;

function asRows(value: unknown): Rows | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v)) ? (value as Rows) : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Dollar amount one recorded chain entry is entitled to, or `null` when the entry declares neither `amount` nor `share`. */
function expectedEntryAmount(entry: Record<string, unknown>, total: number): number | null {
  if (isFiniteNumber(entry.amount)) return entry.amount;
  if (isFiniteNumber(entry.share) && entry.share >= 0 && entry.share <= 1) return entry.share * total;
  return null;
}

function expectedPayees(recorded: Record<string, unknown>, total: number): ExpectedPayee[] | string {
  const rows = asRows(recorded.chain);
  if (!rows || rows.length === 0) return 'recorded payee manifest has no chain';
  const out: ExpectedPayee[] = [];
  for (const row of rows) {
    const amount = expectedEntryAmount(row, total);
    if (!isNonEmptyString(row.did) || !isNonEmptyString(row.role) || amount === null) {
      return 'recorded payee manifest has a chain entry without did, role and amount/share';
    }
    out.push({ did: row.did, role: row.role, amount });
  }
  return out;
}

function expectedTaxes(recorded: Record<string, unknown>): ExpectedTax[] | string {
  const credits = asRows(recorded.taxCredits);
  if (credits) {
    const out: ExpectedTax[] = [];
    for (const c of credits) {
      if (!isNonEmptyString(c.did) || !isNonEmptyString(c.jurisdiction) || !isNonEmptyString(c.kind) || !isFiniteNumber(c.amount)) {
        return 'recorded payee manifest has a malformed taxCredits entry';
      }
      out.push({ did: c.did, jurisdiction: c.jurisdiction, kind: c.kind, amount: c.amount });
    }
    return out;
  }

  const taxes = asRows(recorded.taxes);
  if (!taxes) return [];
  const out: ExpectedTax[] = [];
  for (const t of taxes) {
    if (!isNonEmptyString(t.collectorDid) || !isNonEmptyString(t.jurisdiction) || !isNonEmptyString(t.kind) || !isFiniteNumber(t.amount)) {
      return 'recorded payee manifest has a malformed taxes entry';
    }
    // Checkout `taxes[].amount` is integer cents; settle's `taxCredits[].amount` is dollars.
    out.push({ did: t.collectorDid, jurisdiction: t.jurisdiction, kind: t.kind, amount: t.amount / 100 });
  }
  return out;
}

/** Sort by key, then by amount, so duplicate keys still pair up deterministically. */
function compareKey<T extends { amount: number }>(keyOf: (row: T) => string) {
  return (a: T, b: T) => keyOf(a).localeCompare(keyOf(b)) || a.amount - b.amount;
}

/** Compare two same-key-sorted lists element-wise; `null` when they agree. */
function diffLists<E extends { amount: number }, P extends { amount: number }>(
  label: string,
  expected: E[],
  posted: P[],
  keyOfExpected: (row: E) => string,
  keyOfPosted: (row: P) => string,
): string | null {
  if (expected.length !== posted.length) {
    return `posted ${label} has ${posted.length} entries, recorded payee manifest has ${expected.length}`;
  }
  const exp = [...expected].sort(compareKey(keyOfExpected));
  const got = [...posted].sort(compareKey(keyOfPosted));
  for (const [i, want] of exp.entries()) {
    const have = got[i];
    if (keyOfExpected(want) !== keyOfPosted(have)) {
      return `posted ${label} entry '${keyOfPosted(have)}' is not in the recorded payee manifest`;
    }
    if (Math.abs(want.amount - have.amount) > AMOUNT_TOLERANCE) {
      return `posted ${label} amount for '${keyOfExpected(want)}' (${have.amount}) does not match the recorded payee manifest (${want.amount})`;
    }
  }
  return null;
}

function postedPayees(chain: unknown): ExpectedPayee[] | string {
  const rows = asRows(chain);
  if (!rows) return 'posted fair_manifest.chain must be an array of entries';
  const out: ExpectedPayee[] = [];
  for (const row of rows) {
    if (!isNonEmptyString(row.did) || !isNonEmptyString(row.role) || !isFiniteNumber(row.amount)) {
      return 'posted fair_manifest.chain entries need did, role and amount';
    }
    out.push({ did: row.did, role: row.role, amount: row.amount });
  }
  return out;
}

function postedTaxes(taxCredits: unknown): ExpectedTax[] | string {
  if (taxCredits === undefined || taxCredits === null) return [];
  const rows = asRows(taxCredits);
  if (!rows) return 'posted fair_manifest.taxCredits must be an array of entries';
  const out: ExpectedTax[] = [];
  for (const row of rows) {
    if (!isNonEmptyString(row.did) || !isNonEmptyString(row.jurisdiction) || !isNonEmptyString(row.kind) || !isFiniteNumber(row.amount)) {
      return 'posted fair_manifest.taxCredits entries need did, amount, jurisdiction and kind';
    }
    out.push({ did: row.did, jurisdiction: row.jurisdiction, kind: row.kind, amount: row.amount });
  }
  return out;
}

/**
 * Verify a posted `fair_manifest` against the payee manifest recorded at
 * checkout. Returns `null` when the posted chain (and tax credits) match
 * exactly, or a human-readable mismatch reason. A missing/non-object recorded
 * manifest is a mismatch — an app that declared no payees at checkout has
 * nothing the kernel can verify a settlement against.
 */
export function verifyAgainstPayeeManifest(params: {
  recorded: unknown;
  posted: { chain?: unknown; taxCredits?: unknown };
  /** The payment total in dollars — resolves share-based recorded entries. */
  totalAmount: number;
}): string | null {
  const { recorded, posted, totalAmount } = params;
  if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) {
    return 'no payee manifest was recorded for this payment';
  }
  const rec = recorded as Record<string, unknown>;

  const wantPayees = expectedPayees(rec, totalAmount);
  if (typeof wantPayees === 'string') return wantPayees;
  const havePayees = postedPayees(posted.chain);
  if (typeof havePayees === 'string') return havePayees;
  const chainDiff = diffLists('chain', wantPayees, havePayees, (r) => `${r.did}|${r.role}`, (r) => `${r.did}|${r.role}`);
  if (chainDiff) return chainDiff;

  const wantTaxes = expectedTaxes(rec);
  if (typeof wantTaxes === 'string') return wantTaxes;
  const haveTaxes = postedTaxes(posted.taxCredits);
  if (typeof haveTaxes === 'string') return haveTaxes;
  const taxKey = (r: ExpectedTax) => `${r.did}|${r.jurisdiction}|${r.kind}`;
  return diffLists('taxCredits', wantTaxes, haveTaxes, taxKey, taxKey);
}
