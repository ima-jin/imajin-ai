/**
 * Tests for apps/learn/app/api/courses/[slug]/enroll/route.ts
 *
 * This route had no prior coverage; added alongside the #2137 PAY_SERVICE_URL
 * fallback fix to raise new-code coverage. Exercises the already-enrolled
 * short-circuit, the free-enrollment path (course + lesson-progress inserts),
 * and the paid-enrollment path's pay-service checkout call (success and
 * failure) — all of which touch the module-level PAY_SERVICE_URL constant
 * corrected in this PR (stale `:3004` fallback -> kernel-prefixed `:3000/pay`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const selectMock = vi.fn(() => {
    const rows = selectQueue.shift() ?? [];
    const terminal = Object.assign(Promise.resolve(rows), { limit: vi.fn(async () => rows) });
    return { from: vi.fn(() => ({ where: vi.fn(() => terminal) })) };
  });
  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  return {
    selectQueue,
    selectMock,
    insertValuesMock,
    insertMock,
    requireAuthMock: vi.fn(),
    publishMock: vi.fn().mockResolvedValue(undefined),
    fetchMock: vi.fn(),
  };
});

function queueSelect(rows: unknown[]): void {
  mocks.selectQueue.push(rows);
}

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/db', () => ({
  db: { select: mocks.selectMock, insert: mocks.insertMock },
}));

vi.mock('@/db/schema', () => ({
  courses: {}, enrollments: {}, lessons: { id: 'col_id' }, modules: {}, lessonProgress: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@/lib/utils', () => ({
  generateId: (prefix: string) => `${prefix}_test123`,
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
  errorResponse: (error: string, status = 400) => Response.json({ error }, { status }),
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
  return new Request('https://learn.test/api/courses/intro/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const ROUTE_PARAMS = { params: Promise.resolve({ slug: 'intro' }) };

const FREE_COURSE = { id: 'course_1', slug: 'intro', status: 'published', price: 0, currency: 'CAD', creatorDid: 'did:imajin:creator', title: 'Intro Course' };
const PAID_COURSE = { ...FREE_COURSE, price: 5000 };

describe('POST /api/courses/[slug]/enroll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectQueue.length = 0;
    mocks.insertValuesMock.mockResolvedValue(undefined);
    mocks.publishMock.mockResolvedValue(undefined);
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:student', actingAs: null } });
    vi.stubGlobal('fetch', mocks.fetchMock);
  });

  it('returns the auth error/status when unauthenticated', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(401);
  });

  it('returns 404 when the course does not exist', async () => {
    queueSelect([]); // courses lookup misses

    const res = await POST(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(404);
  });

  it('returns 400 when the course is not published', async () => {
    queueSelect([{ ...FREE_COURSE, status: 'draft' }]);

    const res = await POST(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(400);
  });

  it('short-circuits with the existing enrollment when already enrolled', async () => {
    queueSelect([FREE_COURSE]);
    queueSelect([{ id: 'enr_existing', courseId: FREE_COURSE.id, studentDid: 'did:imajin:student' }]);

    const res = await POST(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enrolled: true, enrollment: { id: 'enr_existing', courseId: FREE_COURSE.id, studentDid: 'did:imajin:student' } });
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('enrolls for free, seeds lesson progress for every module, and publishes learn.enrolled', async () => {
    queueSelect([FREE_COURSE]);
    queueSelect([]); // no existing enrollment
    queueSelect([{ id: 'mod_1', courseId: FREE_COURSE.id }]); // one module
    queueSelect([{ id: 'lesson_1' }, { id: 'lesson_2' }]); // two lessons in that module

    const res = await POST(makeRequest(), ROUTE_PARAMS);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.enrolled).toBe(true);
    expect(body.enrollment.studentDid).toBe('did:imajin:student');
    expect(body.enrollment.paymentId).toBeNull();

    // enrollment insert + lessonProgress insert
    expect(mocks.insertMock).toHaveBeenCalledTimes(2);
    expect(mocks.insertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({ lessonId: 'lesson_1', status: 'not_started' }),
      expect.objectContaining({ lessonId: 'lesson_2', status: 'not_started' }),
    ]);
    expect(mocks.publishMock).toHaveBeenCalledWith('learn.enrolled', expect.objectContaining({
      issuer: FREE_COURSE.creatorDid,
      subject: 'did:imajin:student',
    }));
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('initiates pay-service checkout for a paid course and returns the checkout URL', async () => {
    queueSelect([PAID_COURSE]);
    queueSelect([]); // no existing enrollment
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://checkout.example/cs_learn_1' }) });

    const res = await POST(makeRequest({}, { origin: 'https://learn.test' }), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enrolled: false, checkoutUrl: 'https://checkout.example/cs_learn_1' });

    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    const [url] = mocks.fetchMock.mock.calls[0];
    expect(url).toContain('/api/checkout');
    expect(url).not.toContain('/pay/pay/');
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the pay service rejects the checkout request', async () => {
    queueSelect([PAID_COURSE]);
    queueSelect([]);
    mocks.fetchMock.mockResolvedValue({ ok: false, text: async () => 'invalid manifest' });

    const res = await POST(makeRequest({}, { origin: 'https://learn.test' }), ROUTE_PARAMS);

    expect(res.status).toBe(502);
  });

  it('returns 503 when the pay service is unreachable', async () => {
    queueSelect([PAID_COURSE]);
    queueSelect([]);
    mocks.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await POST(makeRequest({}, { origin: 'https://learn.test' }), ROUTE_PARAMS);

    expect(res.status).toBe(503);
  });
});
