/**
 * Coverage for EventPage's `checkSellerConnected()` (#2137).
 *
 * `checkSellerConnected` is an unexported helper invoked unconditionally by
 * the default-exported `EventPage` RSC, so it can only be exercised by
 * running the real page function end-to-end with its dependencies mocked —
 * same approach as `event-edit-page.test.tsx` for the sibling edit page.
 *
 * These tests pin the corrected `http://localhost:3000/pay` fallback (the
 * previous `http://localhost:3004` value predated the kernel consolidation
 * and pointed at nothing real) and each of the function's three outcomes:
 * charges enabled, charges explicitly disabled, and a network failure that
 * must default to "connected" so a flaky pay service never blocks checkout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  sqlMock: vi.fn(async () => []),
  getSessionMock: vi.fn(),
  notFoundMock: vi.fn(),
  fetchMock: vi.fn(),
  ticketsSectionMock: vi.fn(() => null),
}));

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.orderBy = vi.fn(async () => result);
  return chain;
}

vi.mock('next/navigation', () => ({
  notFound: mocks.notFoundMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/src/db', () => ({
  db: { select: (...args: unknown[]) => mocks.dbSelectMock(...args) },
  events: {}, ticketTypes: {}, tickets: {}, orders: {}, eventInvites: {},
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@/src/lib/email', () => ({
  generateQRCode: vi.fn(),
}));

vi.mock('@/src/lib/contact-email', () => ({
  getContactEmail: vi.fn(),
}));

vi.mock('@/src/lib/location', () => ({
  getLocationType: vi.fn(() => 'physical'),
}));

vi.mock('@imajin/config', () => ({
  eventUrl: vi.fn(() => 'https://events.test/e/evt_1'),
  eventAdminPath: vi.fn(() => '/admin/evt_1'),
  eventEditPath: vi.fn(() => '/e/evt_1/edit'),
  buildPublicUrl: vi.fn((svc: string) => `https://${svc}.test`),
  buildPublicUrlAbsolute: vi.fn((svc: string) => `https://${svc}.test`),
}));

vi.mock('../tickets-section', () => ({ TicketsSection: mocks.ticketsSectionMock }));
vi.mock('../campaign-section', () => ({ CampaignSection: vi.fn(() => null) }));
vi.mock('../countdown', () => ({ Countdown: vi.fn(() => null) }));
vi.mock('../event-lobby-accordion', () => ({ EventLobbyAccordion: vi.fn(() => null) }));
vi.mock('../survey-accordion', () => ({ SurveyAccordion: vi.fn(() => null) }));
vi.mock('@imajin/fair/react', () => ({ FairAccordion: vi.fn(() => null) }));
vi.mock('../tickets-gate', () => ({ TicketsGate: vi.fn(({ children }: any) => children) }));
vi.mock('../magic-link-button', () => ({ MagicLinkButton: vi.fn(() => null) }));
vi.mock('../re-auth-banner', () => ({ ReAuthBanner: vi.fn(() => null) }));
vi.mock('../share-button', () => ({ ShareButton: vi.fn(() => null) }));
vi.mock('@imajin/ui', () => ({ MarkdownContent: vi.fn(() => null) }));

vi.mock('@imajin/auth', () => ({
  getSession: mocks.getSessionMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import EventPage from '../page';

// ─── Helpers ────────────────────────────────────────────────────────────────

const EVENT = {
  id: 'evt_1',
  did: 'did:imajin:event1',
  creatorDid: 'did:imajin:creator',
  podId: null,
  status: 'published',
  accessMode: 'public',
  startsAt: new Date('2030-01-01T18:00:00.000Z'),
  endsAt: null,
  timezone: 'UTC',
  metadata: {},
  emtEmail: null,
  eventType: 'ticketed',
  chatEnabled: false,
  courseSlug: null,
  imageUrl: null,
  title: 'Test Event',
  description: null,
  venue: null,
  address: null,
  city: null,
  virtualUrl: null,
  locationType: null,
  isVirtual: false,
};

const ROUTE_PROPS = {
  params: Promise.resolve({ eventId: 'evt_1' }),
  searchParams: Promise.resolve({}),
};

/** Recursively search a React element tree (as returned, unrendered) for an element whose component function has the given name. */
function findByComponentName(node: unknown, name: string): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  const type = el.type as { name?: string } | string | undefined;
  if (type && typeof type === 'function' && (type as { name?: string }).name === name) {
    return el as { props: Record<string, unknown> };
  }
  const children = el.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findByComponentName(child, name);
      if (found) return found;
    }
  } else if (children) {
    return findByComponentName(children, name);
  }
  return null;
}

let originalPayServiceUrl: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalPayServiceUrl = process.env.PAY_SERVICE_URL;
  delete process.env.PAY_SERVICE_URL;

  mocks.dbSelectMock
    .mockReturnValueOnce(selectChain([EVENT])) // getEvent
    .mockReturnValueOnce(selectChain([]));      // getTicketTypes
  mocks.getSessionMock.mockResolvedValue(null);
  vi.stubGlobal('fetch', mocks.fetchMock);
});

afterEach(() => {
  if (originalPayServiceUrl === undefined) delete process.env.PAY_SERVICE_URL;
  else process.env.PAY_SERVICE_URL = originalPayServiceUrl;
  vi.unstubAllGlobals();
});

function connectCheckUrl(): string | undefined {
  const call = mocks.fetchMock.mock.calls.find(
    ([url]) => typeof url === 'string' && url.includes('/api/connect/check'),
  );
  return call?.[0] as string | undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EventPage -> checkSellerConnected (#2137: kernel-prefixed :3000/pay fallback)', () => {
  it('uses the corrected http://localhost:3000/pay fallback (not the stale :3004 one) and reports connected when charges are enabled', async () => {
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/connect/check')) {
        return { ok: true, json: async () => ({ chargesEnabled: true }) };
      }
      return { ok: false };
    });

    const element = await EventPage(ROUTE_PROPS as any);

    expect(connectCheckUrl()).toBe(
      `http://localhost:3000/pay/api/connect/check?did=${encodeURIComponent(EVENT.creatorDid)}`,
    );
    expect(connectCheckUrl()).not.toContain('localhost:3004');

    const panel = findByComponentName(element, 'EventTicketsPanel');
    expect(panel).not.toBeNull();
    expect(panel!.props.sellerConnected).toBe(true);
  });

  it('reports not-connected when the pay service explicitly reports charges disabled', async () => {
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/connect/check')) {
        return { ok: true, json: async () => ({ chargesEnabled: false }) };
      }
      return { ok: false };
    });

    const element = await EventPage(ROUTE_PROPS as any);

    const panel = findByComponentName(element, 'EventTicketsPanel');
    expect(panel!.props.sellerConnected).toBe(false);
  });

  it('defaults to connected (fail open) when the pay service check throws', async () => {
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/connect/check')) {
        throw new Error('ECONNREFUSED');
      }
      return { ok: false };
    });

    const element = await EventPage(ROUTE_PROPS as any);

    const panel = findByComponentName(element, 'EventTicketsPanel');
    expect(panel!.props.sellerConnected).toBe(true);
  });

  it('defaults to connected (fail open) when the pay service responds non-OK', async () => {
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/connect/check')) {
        return { ok: false, status: 500 };
      }
      return { ok: false };
    });

    const element = await EventPage(ROUTE_PROPS as any);

    const panel = findByComponentName(element, 'EventTicketsPanel');
    expect(panel!.props.sellerConnected).toBe(true);
  });

  it('honors an explicit PAY_SERVICE_URL override instead of the fallback', async () => {
    process.env.PAY_SERVICE_URL = 'https://kernel.example.com/pay';
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/connect/check')) {
        return { ok: true, json: async () => ({ chargesEnabled: true }) };
      }
      return { ok: false };
    });

    await EventPage(ROUTE_PROPS as any);

    expect(connectCheckUrl()).toBe(
      `https://kernel.example.com/pay/api/connect/check?did=${encodeURIComponent(EVENT.creatorDid)}`,
    );
  });
});
