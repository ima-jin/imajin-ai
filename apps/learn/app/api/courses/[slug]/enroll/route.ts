import { NextRequest } from 'next/server';
import { db } from '@/db';
import { courses, enrollments, lessons, modules, lessonProgress } from '@/db/schema';
import { requireAuth } from '@imajin/auth';
import { generateId, jsonResponse, errorResponse } from '@/lib/utils';
import { emitAttestation } from '@imajin/auth';
import { eq, and } from 'drizzle-orm';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL || 'http://localhost:3004';

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * POST /api/courses/[slug]/enroll — Enroll in course (free) or initiate payment (paid)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const { identity } = authResult;

  const courseResult = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  if (!courseResult[0]) return errorResponse('Course not found', 404);

  const course = courseResult[0];

  if (course.status !== 'published') return errorResponse('Course is not available for enrollment', 400);

  // Check if already enrolled
  const existing = await db.select().from(enrollments)
    .where(and(
      eq(enrollments.courseId, course.id),
      eq(enrollments.studentDid, identity.id),
    )).limit(1);

  if (existing.length > 0) {
    return jsonResponse({ enrolled: true, enrollment: existing[0] });
  }

  // Free enrollment
  if (!course.price || course.price === 0) {
    const enrollment = {
      id: generateId('enr'),
      courseId: course.id,
      studentDid: identity.id,
      paymentId: null,
    };

    await db.insert(enrollments).values(enrollment);

    // Initialize progress for all lessons
    const courseModules = await db.select().from(modules).where(eq(modules.courseId, course.id));
    for (const mod of courseModules) {
      const moduleLessons = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.moduleId, mod.id));
      if (moduleLessons.length > 0) {
        await db.insert(lessonProgress).values(
          moduleLessons.map(l => ({
            enrollmentId: enrollment.id,
            lessonId: l.id,
            status: 'not_started',
          }))
        );
      }
    }

    await emitAttestation({
      issuer_did: course.creatorDid,
      subject_did: identity.id,
      type: 'learn.enrolled',
      context_id: course.id,
      context_type: 'course',
      payload: {
        course_title: course.title,
        enrolled_at: new Date().toISOString(),
      },
    });

    return jsonResponse({ enrolled: true, enrollment }, 201);
  }

  // Paid enrollment — redirect to pay service
  const body = await request.json().catch(() => ({}));
  const successUrl = body.successUrl || `${request.headers.get('origin') || ''}/api/courses/${slug}/enroll/callback`;
  const cancelUrl = body.cancelUrl || `${request.headers.get('origin') || ''}/${slug}`;

  try {
    const checkoutResponse = await fetch(`${PAY_SERVICE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          name: course.title,
          description: `Enrollment in "${course.title}"`,
          amount: course.price,
          currency: course.currency || 'CAD',
          quantity: 1,
          metadata: {
            type: 'course_enrollment',
            courseId: course.id,
            studentDid: identity.id,
          },
        }],
        successUrl,
        cancelUrl,
        metadata: {
          source: 'learn',
          courseId: course.id,
          studentDid: identity.id,
        },
      }),
    });

    if (!checkoutResponse.ok) {
      const error = await checkoutResponse.text();
      console.error('Pay service error:', error);
      return errorResponse('Payment initiation failed', 502);
    }

    const checkout = await checkoutResponse.json();
    return jsonResponse({ enrolled: false, checkoutUrl: checkout.url });
  } catch (error) {
    console.error('Pay service unreachable:', error);
    return errorResponse('Payment service unavailable', 503);
  }
}
