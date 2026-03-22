import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, modules } from '@/db/schema';
import { requireHardDID } from '@imajin/auth';
import { generateId, jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, asc, sql } from 'drizzle-orm';

type RouteParams = { params: Promise<{ slug: string }> };

async function getCourseBySlug(slug: string) {
  const result = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  return result[0] || null;
}

/**
 * POST /api/courses/[slug]/modules — Add module
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await requireHardDID(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);
  if (course.creatorDid !== authResult.identity.id) return errorResponse('Not authorized', 403);

  const body = await request.json();
  if (!body.title?.trim()) return errorResponse('Title is required');

  // Get next sort order
  const maxOrder = await db.select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(modules).where(eq(modules.courseId, course.id));

  const mod = {
    id: generateId('mod'),
    courseId: course.id,
    title: body.title.trim(),
    description: body.description?.trim() || null,
    sortOrder: body.sortOrder ?? (Number(maxOrder[0]?.max ?? -1) + 1),
  };

  await db.insert(modules).values(mod);
  return jsonResponse(mod, 201);
}

/**
 * GET /api/courses/[slug]/modules — List modules
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);

  const result = await db.select()
    .from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(asc(modules.sortOrder));

  return jsonResponse({ modules: result });
}
