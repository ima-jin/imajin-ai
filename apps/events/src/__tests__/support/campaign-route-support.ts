/**
 * Shared fixtures and "it" blocks for the crowdfunding campaign route suites
 * (`app/api/campaign/**`): pledge, pledge/confirm, [eventId]/status,
 * my-pledge, pledges, settle and cancel.
 *
 * Builds on the common route-test seams — importing this module BEFORE the
 * route under test registers every mock:
 *   - `./route-test-support`   logger, `@/lib/auth`, `@imajin/config` (cors, rateLimit, getClientIP)
 *   - `./db-queue-support`     queue-based drizzle `db`
 *   - `./kernel-mock-support`  `@/lib/kernel` (pay URL), `fetch`, `PAY_SERVICE_API_KEY`
 *
 * All the cross-route behaviour (preflight, rate limit, auth failure, missing
 * id, unknown event, non-campaign event, non-creator, 500) is expressed once
 * here so the suites only spell out what is specific to their route.
 */
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import {
  authFailure,
  authSuccess,
  corsHeadersMock,
  mockLog,
  rateLimitMock,
  requireAuthMock,
  resetRouteTestMocks,
} from './route-test-support';
import { insertMock, nextSelect, resetDbMocks, selectMock, updateMock } from './db-queue-support';
import { fetchMock, resetKernelMocks } from './kernel-mock-support';

export const EVENT_ID = 'evt_campaign';
export const CREATOR_DID = 'did:imajin:creator';
export const BACKER_DID = 'did:imajin:backer';
export const OTHER_DID = 'did:imajin:stranger';
const CORS_HEADER = 'access-control-allow-origin';
export const CORS = { [CORS_HEADER]: 'https://app.test' };

export const ERR_EVENT_NOT_FOUND = 'Event not found';
export const ERR_NOT_CAMPAIGN = 'Not a campaign event';
export const ERR_EVENT_ID_REQUIRED = 'eventId is required';
export const RATE_WINDOW_MS = 60_000;

type RouteCall = () => Promise<Response>;

/** A campaign event row; override any column. */
export function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    eventType: 'campaign',
    status: 'published',
    creatorDid: CREATOR_DID,
    targetAmount: 10_000,
    deadline: null,
    ...overrides,
  };
}

/** A pledge row; override any column. */
export function makePledge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plg_1',
    eventId: EVENT_ID,
    backerDid: BACKER_DID,
    amount: 5000,
    currency: 'CAD',
    status: 'confirmed',
    stripeSetupIntentId: 'seti_1',
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    metadata: {},
    ...overrides,
  };
}

/** `/api/campaign/<eventId>/<action>` request (pass `''` as the id for the missing-id case). */
export function campaignRequest(eventId: string, action: string, method = 'POST'): NextRequest {
  return new NextRequest(`https://events.test/api/campaign/${eventId}/${action}`, { method });
}

/** `POST /api/campaign/<path>` with a JSON body (`body` is sent verbatim when it is a string — use that for malformed JSON). */
export function campaignJsonRequest(path: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`https://events.test/api/campaign/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Authenticate the next request as `did`. */
export function signInAs(did: string): void {
  requireAuthMock.mockResolvedValue(authSuccess(did));
}

/** `beforeEach` reset for every campaign suite: signed in as the creator, CORS headers on. */
export function resetCampaignMocks(): void {
  resetRouteTestMocks();
  resetDbMocks();
  resetKernelMocks();
  corsHeadersMock.mockReturnValue(CORS);
  signInAs(CREATOR_DID);
}

/** The route echoed the CORS headers from `corsHeaders(request)`. */
export function expectCors(res: Response): void {
  expect(res.headers.get(CORS_HEADER)).toBe(CORS[CORS_HEADER]);
}

function expectNoMutations(): void {
  expect(updateMock).not.toHaveBeenCalled();
  expect(insertMock).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

// ─── Shared "it" blocks ────────────────────────────────────────────────────

export function itAnswersPreflight(preflight: (request: NextRequest) => Response): void {
  it('answers OPTIONS with 204 and the CORS headers', () => {
    const res = preflight(campaignRequest(EVENT_ID, 'x', 'OPTIONS'));

    expect(res.status).toBe(204);
    expectCors(res);
    expect(res.body).toBeNull();
  });
}

export function itRateLimits(call: RouteCall, limit: number): void {
  it(`answers 429 with Retry-After once ${limit} requests/min are exceeded`, async () => {
    rateLimitMock.mockReturnValue({ limited: true, retryAfter: 42 });

    const res = await call();

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests', retryAfter: 42 });
    expect(res.headers.get('retry-after')).toBe('42');
    expectCors(res);
    expect(rateLimitMock).toHaveBeenCalledWith('203.0.113.7', limit, RATE_WINDOW_MS);
    expect(requireAuthMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });
}

export function itRejectsUnauthenticated(call: RouteCall): void {
  it('returns the auth failure (with CORS headers) and touches nothing', async () => {
    requireAuthMock.mockResolvedValue(authFailure(401, 'Unauthorized'));

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expectCors(res);
    expect(selectMock).not.toHaveBeenCalled();
    expectNoMutations();
  });
}

/** `call` must target a URL whose `{eventId}` segment is empty. */
export function itRejectsMissingEventId(call: RouteCall): void {
  it('answers 400 when the URL carries no event id', async () => {
    const res = await call();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ERR_EVENT_ID_REQUIRED });
    expect(selectMock).not.toHaveBeenCalled();
    expectNoMutations();
  });
}

export function itRejectsUnknownEvent(call: RouteCall): void {
  it('answers 404 when the event does not exist', async () => {
    nextSelect([]);

    const res = await call();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ERR_EVENT_NOT_FOUND });
    expectNoMutations();
  });
}

export function itRejectsNonCampaignEvent(call: RouteCall): void {
  it('answers 400 when the event is not a campaign', async () => {
    nextSelect([makeEvent({ eventType: 'standard' })]);

    const res = await call();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ERR_NOT_CAMPAIGN });
    expectNoMutations();
  });
}

export function itRejectsNonCreator(call: RouteCall, error: string): void {
  it('answers 403 when the caller is not the campaign creator', async () => {
    nextSelect([makeEvent({ creatorDid: OTHER_DID })]);

    const res = await call();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error });
    expectCors(res);
    expectNoMutations();
  });
}

/** `queueFailure` queues whatever makes the route throw; the catch-all must answer 500 and log. */
export function itAnswers500WhenHandlerThrows(
  call: RouteCall,
  queueFailure: () => void,
  expected: { error: string; logMessage: string },
): void {
  it('answers 500 and logs when the handler throws', async () => {
    queueFailure();

    const res = await call();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expected.error });
    expectCors(res);
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, expected.logMessage);
  });
}
