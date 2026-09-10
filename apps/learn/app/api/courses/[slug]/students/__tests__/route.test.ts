/**
 * Tests for apps/learn/app/api/courses/[slug]/students/route.ts (GET)
 *
 * #2155: this route used to run a raw `db.execute(sql\`...\`)` query against
 * the kernel-owned profiles table directly to resolve enrolled students'
 * names/emails/handles. It now calls the shared `resolveIdentitiesForDids`
 * client (backed by the profile service's batched `/api/resolve` route,
 * #1998) instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const resultQueue: unknown[][] = [];

  function makeChain() {
    const value = resultQueue.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject),
    };
    return chain;
  }

  return {
    resultQueue,
    selectMock: vi.fn(() => makeChain()),
    requireHardDIDMock: vi.fn(),
    resolveIdentitiesForDidsMock: vi.fn(),
  };
});

vi.mock('@/db', () => ({
  db: { select: mocks.selectMock },
}));

vi.mock('@/db/schema', () => ({
  courses: { id: 'col_id', slug: 'col_slug', creatorDid: 'col_creator_did', title: 'col_title' },
  enrollments: { id: 'col_id', courseId: 'col_course_id', studentDid: 'col_student_did', enrolledAt: 'col_enrolled_at' },
  lessonProgress: { enrollmentId: 'col_enrollment_id', status: 'col_status' },
  lessons: { id: 'col_id', moduleId: 'col_module_id' },
  modules: { id: 'col_id', courseId: 'col_course_id' },
}));

vi.mock('@imajin/auth', () => ({
  requireHardDID: mocks.requireHardDIDMock,
  resolveActingDid: (identity: { actingAs?: string | null; id: string }) => identity.actingAs ?? identity.id,
  resolveIdentitiesForDids: mocks.resolveIdentitiesForDidsMock,
}));

vi.mock('@/lib/utils', () => ({
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
  errorResponse: (error: string, status = 400) => Response.json({ error }, { status }),
}));

import { GET } from '../route';

const ROUTE_PARAMS = { params: Promise.resolve({ slug: 'test-course' }) };

function makeRequest(): Request {
  return new Request('https://learn.test/api/courses/test-course/students', { headers: { cookie: 'session=abc' } });
}

const COURSE_ROW = { id: 'crs_1', slug: 'test-course', title: 'Test Course', creatorDid: 'did:imajin:creator' };

describe('GET /api/courses/[slug]/students — batched identity resolution (#1998/#2155)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resultQueue.length = 0;
    mocks.requireHardDIDMock.mockResolvedValue({ identity: { id: 'did:imajin:creator', actingAs: null } });
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(new Map());
  });

  it('resolves enrolled student DIDs in a single batched call', async () => {
    mocks.resultQueue.push(
      [COURSE_ROW], // course lookup
      [], // no modules
      [
        { id: 'enr_1', studentDid: 'did:imajin:a', enrolledAt: '2026-01-01', completedAt: null },
        { id: 'enr_2', studentDid: 'did:imajin:b', enrolledAt: '2026-01-02', completedAt: null },
      ], // enrollments
      [{ completed: 0 }], // progress for enr_1
      [{ completed: 0 }], // progress for enr_2
    );

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    expect(mocks.resolveIdentitiesForDidsMock).toHaveBeenCalledTimes(1);
    const requestedDids = mocks.resolveIdentitiesForDidsMock.mock.calls[0][0] as string[];
    expect(new Set(requestedDids)).toEqual(new Set(['did:imajin:a', 'did:imajin:b']));
  });

  it('populates student displayName/email/handle from the resolved map, not raw SQL columns', async () => {
    mocks.resultQueue.push(
      [COURSE_ROW],
      [],
      [{ id: 'enr_1', studentDid: 'did:imajin:a', enrolledAt: '2026-01-01', completedAt: null }],
      [{ completed: 2 }],
    );
    mocks.resolveIdentitiesForDidsMock.mockResolvedValue(
      new Map([['did:imajin:a', { did: 'did:imajin:a', handle: 'student-a', displayName: 'Student A', email: 'a@example.com' }]]),
    );

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(json.students).toHaveLength(1);
    expect(json.students[0]).toMatchObject({
      studentDid: 'did:imajin:a',
      displayName: 'Student A',
      email: 'a@example.com',
      handle: 'student-a',
    });
  });

  it('skips identity resolution entirely when there are no enrollments', async () => {
    mocks.resultQueue.push([COURSE_ROW], [], []);

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await res.json();

    expect(json.students).toHaveLength(0);
    expect(mocks.resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not the course creator', async () => {
    mocks.requireHardDIDMock.mockResolvedValue({ identity: { id: 'did:imajin:someone-else', actingAs: null } });
    mocks.resultQueue.push([COURSE_ROW]);

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect(mocks.resolveIdentitiesForDidsMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the course is not found', async () => {
    mocks.resultQueue.push([]);

    const res = await GET(makeRequest(), ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });
});
