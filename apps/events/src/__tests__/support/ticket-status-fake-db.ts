/**
 * In-memory stand-in for the drizzle query builder, used by the ticket-holder
 * route tests (#2734). Columns are plain `'table.column'` strings; the mocked
 * drizzle operators build condition trees that `matches` evaluates against
 * fixture rows, so the tests exercise the real status filter the route passes
 * — not a canned result set.
 */
export type Cond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'in'; col: string; vals: unknown[] }
  | { op: 'gt'; col: string; val: unknown }
  | { op: 'and'; conds: Cond[] };

export type Row = Record<string, unknown>;

export const drizzleOps = {
  eq: (col: string, val: unknown): Cond => ({ op: 'eq', col, val }),
  inArray: (col: string, vals: unknown[]): Cond => ({ op: 'in', col, vals }),
  gt: (col: string, val: unknown): Cond => ({ op: 'gt', col, val }),
  and: (...conds: Cond[]): Cond => ({ op: 'and', conds }),
};

export function matches(cond: Cond | undefined, row: Row): boolean {
  if (!cond) return true;
  switch (cond.op) {
    case 'eq':
      return row[cond.col] === cond.val;
    case 'in':
      return cond.vals.includes(row[cond.col]);
    case 'gt':
      return (row[cond.col] as number | Date) > (cond.val as number | Date);
    case 'and':
      return cond.conds.every((c) => matches(c, row));
  }
}

/** Table stubs: every column resolves to its qualified `table.column` name. */
export const ticketsTable = {
  id: 'tickets.id',
  eventId: 'tickets.eventId',
  ownerDid: 'tickets.ownerDid',
  status: 'tickets.status',
};
export const eventsTable = {
  id: 'events.id',
  title: 'events.title',
  startsAt: 'events.startsAt',
  endsAt: 'events.endsAt',
  venue: 'events.venue',
  accessMode: 'events.accessMode',
  imageUrl: 'events.imageUrl',
  creatorDid: 'events.creatorDid',
  status: 'events.status',
};

function joinTicketsToEvents(tickets: Row[], eventRows: Row[]): Row[] {
  const joined: Row[] = [];
  for (const t of tickets) {
    for (const e of eventRows) {
      if (e['events.id'] === t['tickets.eventId']) joined.push({ ...t, ...e });
    }
  }
  return joined;
}

function project(row: Row, fields: Record<string, string>): Row {
  const out: Row = {};
  for (const [key, col] of Object.entries(fields)) out[key] = row[col];
  return out;
}

class FakeQuery implements PromiseLike<Row[]> {
  private source: object | undefined;
  private joined: object | undefined;
  private cond: Cond | undefined;
  private max: number | undefined;

  constructor(
    private readonly tables: Map<object, Row[]>,
    private readonly fields?: Record<string, string>,
  ) {}

  from(t: object) {
    this.source = t;
    return this;
  }

  innerJoin(t: object) {
    this.joined = t;
    return this;
  }

  where(c: Cond) {
    this.cond = c;
    return this;
  }

  limit(n: number) {
    this.max = n;
    return this;
  }

  private run(): Row[] {
    let rows = this.tables.get(this.source!) ?? [];
    if (this.joined) rows = joinTicketsToEvents(rows, this.tables.get(this.joined) ?? []);
    rows = rows.filter((r) => matches(this.cond, r));
    if (this.max !== undefined) rows = rows.slice(0, this.max);
    const { fields } = this;
    return fields ? rows.map((r) => project(r, fields)) : rows;
  }

  then<R1 = Row[], R2 = never>(
    onfulfilled?: ((rows: Row[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
  }
}

/**
 * Build a fake `db`. `tables` maps a table stub to its fixture rows (keyed by
 * qualified column name). `.innerJoin()` merges the tickets rows with the
 * events rows they reference via `tickets.eventId` / `events.id`.
 */
export function createFakeDb(tables: Map<object, Row[]>) {
  return {
    select: (fields?: Record<string, string>) => new FakeQuery(tables, fields),
  };
}

/** Ticket statuses that must never count as held, per the #2734 acceptance. */
export const NON_HOLDING_STATUSES = ['held', 'available', 'cancelled', 'refunded', 'refund_pending'];
