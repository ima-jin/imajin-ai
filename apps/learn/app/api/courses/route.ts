import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, modules, lessons } from '@/db/schema';
import { requireHardDID } from '@imajin/auth';
import { generateId, slugify, jsonResponse, errorResponse } from '@/lib/utils';
import { eq, and, sql, desc } from 'drizzle-orm';

/**
 * POST /api/courses — Create a new course
 */
export async function POST(request: NextRequest) {
  const authResult = await requireHardDID(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const body = await request.json();

  const { title, description, slug, price, currency, visibility, imageUrl, imageAssetId, tags, metadata } = body;

  if (!title?.trim()) {
    return errorResponse('Title is required');
  }

  const courseSlug = slug?.trim() || slugify(title);

  // Check slug uniqueness
  const existing = await db.select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, courseSlug))
    .limit(1);

  if (existing.length > 0) {
    return errorResponse('A course with this slug already exists', 409);
  }

  const course = {
    id: generateId('crs'),
    creatorDid: did,
    title: title.trim(),
    description: description?.trim() || null,
    slug: courseSlug,
    price: price ?? 0,
    currency: currency || 'CAD',
    visibility: visibility || 'public',
    imageUrl: imageUrl || null,
    imageAssetId: imageAssetId || null,
    tags: tags || [],
    metadata: metadata || {},
    status: 'draft' as const,
  };

  await db.insert(courses).values(course);

  return jsonResponse(course, 201);
}

/**
 * GET /api/courses — List published courses (discovery)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const creatorDid = searchParams.get('creator_did');
  const tag = searchParams.get('tag');
  const status = searchParams.get('status') || 'published';
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
  const offset = parseInt(searchParams.get('offset') || '0');

  const conditions = [];

  // Public discovery only shows published courses by default
  conditions.push(eq(courses.status, status));

  if (creatorDid) {
    conditions.push(eq(courses.creatorDid, creatorDid));
  }

  // Visibility filter — only show public courses in discovery
  // Trust-bound courses need connection check (handled in detail endpoint)
  if (!creatorDid) {
    conditions.push(eq(courses.visibility, 'public'));
  }

  const results = await db.select()
    .from(courses)
    .where(and(...conditions))
    .orderBy(desc(courses.createdAt))
    .limit(limit)
    .offset(offset);

  // Add module + lesson counts
  const enriched = await Promise.all(results.map(async (course) => {
    const moduleCounts = await db.select({
      count: sql<number>`count(*)`,
    }).from(modules).where(eq(modules.courseId, course.id));

    const lessonCounts = await db.select({
      count: sql<number>`count(*)`,
    }).from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, course.id));

    return {
      ...course,
      moduleCount: Number(moduleCounts[0]?.count || 0),
      lessonCount: Number(lessonCounts[0]?.count || 0),
    };
  }));

  return jsonResponse({ courses: enriched, limit, offset });
}
