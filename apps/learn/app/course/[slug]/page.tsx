'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { OnboardGate } from '@imajin/onboard';
import { useToast } from '@imajin/ui';
import { apiFetch } from '@imajin/config';

interface Lesson {
  id: string;
  title: string;
  contentType: string;
  durationMinutes: number | null;
  sortOrder: number;
}

interface Module {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  lessons: Lesson[];
}

interface Course {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  price: number;
  currency: string;
  creatorDid: string;
  imageUrl: string | null;
  tags: string[];
  status: string;
  eventSlug: string | null;
  courseType: string | null;
  modules: Module[];
  enrollment: {
    id: string;
    enrolledAt: string;
    progress: { total: number; completed: number };
  } | null;
  isCreator: boolean;
  isAuthenticated: boolean;
}

interface UpcomingEvent {
  id: string;
  title: string;
  startsAt: string;
}

const contentTypeIcons: Record<string, string> = {
  markdown: '📝',
  exercise: '🛠️',
  slide: '📊',
  video: '🎬',
};

export default function CourseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const slug = params.slug as string;

  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [upcomingEvent, setUpcomingEvent] = useState<UpcomingEvent | null>(null);
  const [sellerConnected, setSellerConnected] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch(`/api/courses/${slug}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setCourse(data);

          // Check if course creator has Stripe Connect enabled
          if (data.price > 0 && data.creatorDid) {
            try {
              const payUrl = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';
              const connectRes = await fetch(
                `${payUrl}/api/connect/check?did=${encodeURIComponent(data.creatorDid)}`
              );
              if (connectRes.ok) {
                const connectData = await connectRes.json();
                setSellerConnected(connectData.chargesEnabled ?? false);
              } else {
                setSellerConnected(false);
              }
            } catch {
              // Default to connected on error
            }
          }

          // Fetch next upcoming event for this course
          const eventsUrl = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';
          try {
            const evRes = await fetch(`${eventsUrl}/api/events?courseSlug=${encodeURIComponent(data.slug)}&upcoming=true&limit=1`);
            if (evRes.ok) {
              const evData = await evRes.json();
              setUpcomingEvent(evData.events?.[0] ?? null);
            }
          } catch {
            // silently ignore — banner is non-critical
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slug]);

  // Auto-enroll after onboard email verification redirect
  useEffect(() => {
    if (!course || course.enrollment || enrolling) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('enroll') === '1') {
      window.history.replaceState({}, '', `/course/${slug}`);
      handleEnroll();
    }
  }, [course]);

  // Auto-redirect to presentation mode for decks
  const isDeck = course?.courseType === 'deck';
  useEffect(() => {
    if (!course || !isDeck) return;
    if (course.enrollment && !course.isCreator) {
      router.replace(`/course/${slug}/present`);
    }
  }, [course, isDeck, router, slug]);

  async function handleEnroll() {
    if (!course) return;
    setEnrolling(true);
    try {
      const res = await apiFetch(`/api/courses/${slug}/enroll`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          successUrl: `${window.location.origin}/course/${slug}`,
          cancelUrl: `${window.location.origin}/course/${slug}`,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || 'Enrollment failed');
        return;
      }

      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else if (isDeck) {
        // Free deck enrollment — go straight to presentation
        router.push(`/course/${slug}/present`);
      } else {
        // Free enrollment — reload
        window.location.reload();
      }
    } catch (e) {
      toast.error('Enrollment failed');
    } finally {
      setEnrolling(false);
    }
  }

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-secondary">Loading...</div>;
  if (!course) return <div className="container mx-auto px-4 py-16 text-center text-secondary">Course not found</div>;

  const totalDuration = course.modules.reduce(
    (sum, m) => sum + m.lessons.reduce((s, l) => s + (l.durationMinutes || 0), 0), 0
  );
  const totalLessons = course.modules.reduce((sum, m) => sum + m.lessons.length, 0);

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          {course.imageUrl && (
            <div className="aspect-video overflow-hidden mb-6 bg-surface-elevated dark:bg-surface-elevated">
              <img src={course.imageUrl} alt={course.title} className="w-full h-full object-cover" />
            </div>
          )}

          <h1 className="text-3xl font-bold mb-3">{course.title}</h1>
          {course.description && (
            <p className="text-lg text-muted dark:text-secondary mb-4">{course.description}</p>
          )}

          <div className="flex flex-wrap gap-4 text-sm text-secondary mb-6">
            <span>{course.modules.length} modules</span>
            <span>·</span>
            <span>{totalLessons} lessons</span>
            {totalDuration > 0 && (
              <>
                <span>·</span>
                <span>{totalDuration} min total</span>
              </>
            )}
          </div>

          {course.tags?.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-6">
              {course.tags.map((tag: string) => (
                <span key={tag} className="px-3 py-1 text-sm rounded-full bg-surface-elevated dark:bg-surface-elevated text-muted dark:text-primary">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            {/* Present button — only shown if course has slide lessons */}
            {course.modules.some((m: Module) => m.lessons.some((l: Lesson) => l.contentType === 'slide')) && (
              course.isCreator || course.enrollment
            ) && (
              <Link
                href={`/course/${course.slug}/present`}
                className="px-6 py-3 bg-surface-elevated text-primary:bg-surface-elevated font-medium border border-white/10"
              >
                ▶ Present
              </Link>
            )}
            {course.isCreator ? (
              <Link
                href={`/dashboard/${course.slug}`}
                className="px-6 py-3 bg-imajin-orange text-primary bg-imajin-orange font-medium"
              >
                Edit Course
              </Link>
            ) : course.enrollment ? (
              <Link
                href={isDeck ? `/course/${course.slug}/present` : `/course/${course.slug}/${course.modules[0]?.lessons[0]?.id || ''}`}
                className="px-6 py-3 bg-success text-primary:bg-success/80 font-medium"
              >
                {isDeck ? '▶ View Presentation' : (
                  <>
                    {course.enrollment.progress.completed > 0 ? 'Continue Learning' : 'Start Learning'}
                    {course.enrollment.progress.total > 0 && (
                      <span className="ml-2 text-sm opacity-80">
                        ({Math.round((course.enrollment.progress.completed / course.enrollment.progress.total) * 100)}%)
                      </span>
                    )}
                  </>
                )}
              </Link>
            ) : course.price > 0 && !sellerConnected ? (
              <p className="text-sm text-secondary italic px-1">
                Payments not yet available
              </p>
            ) : course.isAuthenticated ? (
              <button
                onClick={handleEnroll}
                disabled={enrolling}
                className="px-6 py-3 bg-imajin-orange text-primary bg-imajin-orange font-medium disabled:opacity-50"
              >
                {enrolling ? 'Loading...' : course.price === 0
                  ? (isDeck ? '▶ View Presentation' : 'Start Learning — Free')
                  : `Enroll — $${(course.price / 100).toFixed(2)}`}
              </button>
            ) : (
              <OnboardGate
                action={isDeck ? `view "${course.title}"` : `enroll in "${course.title}"`}
                redirectUrl={`${typeof window !== 'undefined' ? window.location.origin : ''}/course/${slug}?enroll=1`}
                onIdentity={() => handleEnroll()}
                authUrl={process.env.NEXT_PUBLIC_AUTH_URL}
              >
                <button
                  disabled={enrolling}
                  className="px-6 py-3 bg-imajin-orange text-primary bg-imajin-orange font-medium disabled:opacity-50"
                >
                  {enrolling ? 'Loading...' : course.price === 0
                    ? (isDeck ? '▶ View Presentation' : 'Start Learning — Free')
                    : `Enroll — $${(course.price / 100).toFixed(2)}`}
                </button>
              </OnboardGate>
            )}
          </div>
        </div>

        {/* Upcoming event banner — dynamically fetched from events service */}
        {upcomingEvent && (
          <div className="mb-8 bg-imajin-orange/5 dark:bg-imajin-orange/5 border border-imajin-orange/20 dark:border-imajin-orange/20 p-5 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-amber-900 dark:text-imajin-orange">🎓 Next session: {upcomingEvent.title}</p>
              <p className="text-sm text-imajin-orange dark:text-imajin-orange mt-1">
                {new Date(upcomingEvent.startsAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
            <a
              href={`${process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai'}/${upcomingEvent.id}`}
              className="shrink-0 px-5 py-2.5 bg-imajin-orange text-primary bg-imajin-orange font-medium text-sm no-underline"
            >
              Get tickets →
            </a>
          </div>
        )}

        {/* Course outline */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Course Outline</h2>
          {course.modules.map((mod, i) => (
            <div key={mod.id} className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 overflow-hidden">
              <div className="px-5 py-4 border-b border-white/10 dark:border-white/10">
                <h3 className="font-medium">
                  <span className="text-secondary mr-2">Module {i + 1}</span>
                  {mod.title}
                </h3>
                {mod.description && <p className="text-sm text-secondary mt-1">{mod.description}</p>}
              </div>
              <ul className="divide-y divide-white/10 dark:divide-white/10">
                {mod.lessons.map((lesson) => (
                  <li key={lesson.id} className="px-5 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span>{contentTypeIcons[lesson.contentType] || '📄'}</span>
                      {course.enrollment ? (
                        <Link
                          href={`/course/${course.slug}/${lesson.id}`}
                          className="hover:text-imajin-orange"
                        >
                          {lesson.title}
                        </Link>
                      ) : (
                        <span>{lesson.title}</span>
                      )}
                    </div>
                    {lesson.durationMinutes && (
                      <span className="text-xs text-secondary">{lesson.durationMinutes} min</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
