/**
 * Shared `vi.mock` boilerplate + fixtures for the apps/events route/page
 * test suites covering the #1998 batched-identity-resolution migration
 * (sales route, sales/export route, guest CSV exports, guests route).
 *
 * These suites all exercise the same seam: a route that used to run raw
 * `auth.identities`/`auth.credentials` joins (or hit a per-DID internal
 * `/api/lookup` fallback) and now calls the batched `resolveIdentitiesForDids`
 * client instead. Sharing this module keeps each suite focused on its own
 * route-specific assertions instead of re-declaring the same `getClient`/
 * `requireAuth`/`isEventOrganizer`/`resolveIdentitiesForDids` mocks.
 *
 * Vitest hoists `vi.mock`/`vi.hoisted` calls to the top of whichever module
 * they're written in, and ES module imports execute in order, so importing
 * this module (before the route under test) registers every mock here
 * exactly as if it were declared inline in the test file itself.
 */
import { vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const queue: unknown[][] = [];
  // Bare/fragment templates with zero interpolated values (e.g. a
  // conditional `sql`` filter fragment embedded in another query) are only
  // ever composed into another `sql`...${fragment}...`` call in real
  // postgres.js usage — never awaited standalone — so they must not
  // consume from the queue.
  const sqlFn = (_strings: TemplateStringsArray, ...values: unknown[]) =>
    values.length === 0 ? ({ __fragment: true } as unknown) : Promise.resolve(queue.shift() ?? []);
  const sqlMock = Object.assign(sqlFn, { queue });
  return {
    sqlMock,
    requireAuthMock: vi.fn(),
    requireAppAuthMock: vi.fn(),
    isEventOrganizerMock: vi.fn(),
    resolveIdentitiesForDidsMock: vi.fn(),
  };
});

export const {
  sqlMock,
  requireAuthMock,
  requireAppAuthMock,
  isEventOrganizerMock,
  resolveIdentitiesForDidsMock,
} = hoisted;

/** Queue a raw-SQL result for the next real (non-fragment) `sql` tagged-template call. */
export function nextSql(rows: unknown[]): void {
  sqlMock.queue.push(rows);
}

/** Common `beforeEach` reset every suite in this family shares. */
export function resetResolveRouteMocks(): void {
  vi.clearAllMocks();
  sqlMock.queue.length = 0;
  requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:organizer', actingAs: null } });
  isEventOrganizerMock.mockResolvedValue({ authorized: true });
  resolveIdentitiesForDidsMock.mockResolvedValue(new Map());
}

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => sqlMock,
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  requireAppAuth: requireAppAuthMock,
  resolveIdentitiesForDids: resolveIdentitiesForDidsMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: isEventOrganizerMock,
}));

/**
 * The root vitest config's `@/` alias points at apps/kernel, not apps/events,
 * so `@/src/lib/attendee` must be mocked explicitly for any suite that
 * exercises a route importing it. Reimplements the real (pure,
 * dependency-free) precedence logic from apps/events/src/lib/attendee.ts so
 * those suites still exercise realistic name/email resolution behavior.
 */
vi.mock('@/src/lib/attendee', () => ({
  resolveAttendee: (params: {
    surveyName: string | null;
    surveyEmail: string | null;
    identityName: string | null;
    identityContactEmail: string | null;
    identityCredentialEmail: string | null;
    profileName: string | null;
    profileEmail: string | null;
    buyerName: string | null;
    buyerEmail: string | null;
  }) => {
    const norm = (s: string | null | undefined) => (s ?? '').trim();
    const name = norm(params.surveyName) || norm(params.profileName) || norm(params.identityName) || norm(params.buyerName);
    const email = norm(params.surveyEmail) || norm(params.identityContactEmail) || norm(params.identityCredentialEmail) || norm(params.profileEmail) || norm(params.buyerEmail);
    return { name, email, guestOf: '' };
  },
}));
