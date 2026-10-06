/**
 * Keyset cursor for GET /auth/api/attestations (#2533).
 *
 * Wire format: `<issued_at>,<id>` — an ISO-8601 UTC timestamp (millisecond
 * precision) and the attestation id, the id being the tiebreak for rows that
 * share an `issued_at`. Neither half can contain a comma (ISO timestamps and
 * `att_*` ids never do), so the first comma is an unambiguous separator.
 */

export interface AttestationCursor {
  /** ISO-8601 UTC, millisecond precision (`Date#toISOString`). */
  issuedAt: string;
  id: string;
}

/** Encode the last row of a page as the `before` cursor for the next page. */
export function encodeAttestationCursor(row: { issuedAt: Date; id: string }): string {
  return `${row.issuedAt.toISOString()},${row.id}`;
}

/**
 * Parse a `before` query value. Returns null when it is not a well-formed
 * `<issued_at>,<id>` pair (caller maps that to a 400).
 */
export function parseAttestationCursor(raw: string): AttestationCursor | null {
  const separator = raw.indexOf(',');
  if (separator <= 0) return null;

  const id = raw.slice(separator + 1);
  if (!id) return null;

  const parsed = new Date(raw.slice(0, separator));
  if (Number.isNaN(parsed.getTime())) return null;

  return { issuedAt: parsed.toISOString(), id };
}
