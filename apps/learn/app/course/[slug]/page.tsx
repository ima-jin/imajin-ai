'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { OnboardGate } from '@imajin/onboard';

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
  const slug = params.slug as string;

  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [upcomingEvent, setUpcomingEvent] = useState<UpcomingEvent | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/courses/${slug}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setCourse(data);

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

  async function handleEnroll() {
    if (!course) return;
    setEnrolling(true);
    try {
      const res = await fetch(`/api/courses/${slug}/enroll`, {
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
        alert(err.error || 'Enrollment failed');
        return;
      }

      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        // Free enrollment — reload
        window.location.reload();
      }
    } catch (e) {
      alert('Enrollment failed');
    } finally {
      setEnrolling(false);
    }
  }

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>;
  if (!course) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Course not found</div>;

  const totalDuration = course.modules.reduce(
    (sum, m) => sum + m.lessons.reduce((s, l) => s + (l.durationMinutes || 0), 0), 0
  );
  const totalLessons = course.modules.reduce((sum, m) => sum + m.lessons.length, 0);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          {course.imageUrl && (
            <div className="aspect-video rounded-xl overflow-hidden mb-6 bg-gray-100 dark:bg-gray-800">
              <img src={course.imageUrl} alt={course.title} className="w-full h-full object-cover" />
            </div>
          )}

          <h1 className="text-3xl font-bold mb-3">{course.title}</h1>
          {course.description && (
            <p className="text-lg text-gray-600 dark:text-gray-400 mb-4">{course.description}</p>
          )}

          <div className="flex flex-wrap gap-4 text-sm text-gray-500 mb-6">
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
                <span key={tag} className="px-3 py-1 text-sm rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {course.isCreator ? (
              <Link
                href={`/dashboard/${course.slug}`}
                className="px-6 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium"
              >
                Edit Course
              </Link>
            ) : course.enrollment ? (
              <Link
                href={`/course/${course.slug}/${course.modules[0]?.lessons[0]?.id || ''}`}
                className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
              >
                {course.enrollment.progress.completed > 0 ? 'Continue Learning' : 'Start Learning'}
                {course.enrollment.progress.total > 0 && (
                  <span className="ml-2 text-sm opacity-80">
                    ({Math.round((course.enrollment.progress.completed / course.enrollment.progress.total) * 100)}%)
                  </span>
                )}
              </Link>
            ) : course.isAuthenticated ? (
              <button
                onClick={handleEnroll}
                disabled={enrolling}
                className="px-6 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium disabled:opacity-50"
              >
                {enrolling ? 'Enrolling...' : course.price === 0 ? 'Start Learning — Free' : `Enroll — $${(course.price / 100).toFixed(2)}`}
              </button>
            ) : (
              <OnboardGate
                action={`enroll in "${course.title}"`}
                redirectUrl={`${typeof window !== 'undefined' ? window.location.origin : ''}/course/${slug}?enroll=1`}
                onIdentity={() => handleEnroll()}
              >
                <button
                  disabled={enrolling}
                  className="px-6 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium disabled:opacity-50"
                >
                  {enrolling ? 'Enrolling...' : course.price === 0 ? 'Start Learning — Free' : `Enroll — $${(course.price / 100).toFixed(2)}`}
                </button>
              </OnboardGate>
            )}
          </div>
        </div>

        {/* Upcoming event banner — dynamically fetched from events service */}
        {upcomingEvent && (
          <div className="mb-8 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-5 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-amber-900 dark:text-amber-200">🎓 Next session: {upcomingEvent.title}</p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                {new Date(upcomingEvent.startsAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
            <a
              href={`${process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai'}/${upcomingEvent.id}`}
              className="shrink-0 px-5 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium text-sm no-underline"
            >
              Get tickets →
            </a>
          </div>
        )}

        {/* Course outline */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Course Outline</h2>
          {course.modules.map((mod, i) => (
            <div key={mod.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
                <h3 className="font-medium">
                  <span className="text-gray-400 mr-2">Module {i + 1}</span>
                  {mod.title}
                </h3>
                {mod.description && <p className="text-sm text-gray-500 mt-1">{mod.description}</p>}
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {mod.lessons.map((lesson) => (
                  <li key={lesson.id} className="px-5 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span>{contentTypeIcons[lesson.contentType] || '📄'}</span>
                      {course.enrollment ? (
                        <Link
                          href={`/course/${course.slug}/${lesson.id}`}
                          className="hover:text-amber-500"
                        >
                          {lesson.title}
                        </Link>
                      ) : (
                        <span>{lesson.title}</span>
                      )}
                    </div>
                    {lesson.durationMinutes && (
                      <span className="text-xs text-gray-400">{lesson.durationMinutes} min</span>
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
