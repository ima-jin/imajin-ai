'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { simpleMarkdown } from '@/app/lib/markdown';

interface Lesson {
  id: string;
  title: string;
  contentType: string;
  content: string | null;
  durationMinutes: number | null;
  metadata: any;
  locked?: boolean;
}

interface ProgressLesson {
  id: string;
  title: string;
  contentType: string;
  status: string;
}

interface ProgressModule {
  id: string;
  title: string;
  lessons: ProgressLesson[];
}

export default function LessonViewerPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const lessonId = params.lessonId as string;

  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [progress, setProgress] = useState<{ modules: ProgressModule[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);

  // Find adjacent lessons for navigation
  const allLessons = progress?.modules.flatMap(m => m.lessons) || [];
  const currentIndex = allLessons.findIndex(l => l.id === lessonId);
  const prevLesson = currentIndex > 0 ? allLessons[currentIndex - 1] : null;
  const nextLesson = currentIndex < allLessons.length - 1 ? allLessons[currentIndex + 1] : null;
  const currentProgress = allLessons.find(l => l.id === lessonId);

  // Index of this lesson within slide-type lessons only (for "Present from here")
  const slideLessons = allLessons.filter(l => l.contentType === 'slide');
  const slideIndex = slideLessons.findIndex(l => l.id === lessonId);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        // Load lesson content — we need to find its module ID first
        // Use the progress endpoint to get the full structure
        const progressRes = await fetch(`/api/courses/${slug}/progress`, { credentials: 'include' });
        if (progressRes.ok) {
          const prog = await progressRes.json();
          setProgress(prog);

          // Find which module this lesson belongs to
          let moduleId = '';
          for (const mod of prog.modules) {
            if (mod.lessons.find((l: any) => l.id === lessonId)) {
              moduleId = mod.id;
              break;
            }
          }

          if (moduleId) {
            const lessonRes = await fetch(
              `/api/courses/${slug}/modules/${moduleId}/lessons/${lessonId}`,
              { credentials: 'include' }
            );
            if (lessonRes.ok) {
              setLesson(await lessonRes.json());
            }
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slug, lessonId]);

  async function markComplete() {
    setCompleting(true);
    try {
      const res = await fetch(`/api/courses/${slug}/lessons/${lessonId}/complete`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        // Move to next lesson or reload
        if (nextLesson) {
          router.push(`/course/${slug}/${nextLesson.id}`);
        } else {
          router.push(`/course/${slug}`);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setCompleting(false);
    }
  }

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>;
  if (!lesson) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Lesson not found</div>;

  if (lesson.locked) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <div className="text-6xl mb-4">🔒</div>
        <h1 className="text-2xl font-bold mb-4">{lesson.title}</h1>
        <p className="text-gray-500 mb-6">This lesson requires enrollment to access.</p>
        <Link href={`/course/${slug}`} className="px-6 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600">
          View Course
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      <div className="flex">
        {/* Sidebar — module navigation */}
        <aside className="hidden lg:block w-72 border-r border-gray-200 dark:border-gray-800 min-h-screen p-4 overflow-y-auto">
          <Link href={`/course/${slug}`} className="text-sm text-amber-500 hover:underline mb-4 block">
            ← Back to course
          </Link>
          {progress?.modules.map((mod) => (
            <div key={mod.id} className="mb-4">
              <h4 className="font-medium text-sm text-gray-500 mb-2">{mod.title}</h4>
              <ul className="space-y-1">
                {mod.lessons.map((l) => (
                  <li key={l.id}>
                    <Link
                      href={`/course/${slug}/${l.id}`}
                      className={`block px-3 py-1.5 rounded text-sm ${
                        l.id === lessonId
                          ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                    >
                      {l.status === 'completed' && <span className="mr-1">✓</span>}
                      {l.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        {/* Main content */}
        <main className="flex-1 max-w-3xl mx-auto px-6 py-8">
          <div className="mb-2 text-sm text-gray-400">
            {lesson.contentType === 'exercise' && '🛠️ Exercise'}
            {lesson.contentType === 'slide' && '📊 Slide'}
            {lesson.contentType === 'video' && '🎬 Video'}
            {lesson.contentType === 'markdown' && '📝 Lesson'}
            {lesson.durationMinutes && ` · ${lesson.durationMinutes} min`}
          </div>

          <h1 className="text-3xl font-bold mb-6">{lesson.title}</h1>

          {/* Slide content — card-style preview with present button */}
          {lesson.contentType === 'slide' && (
            <div className="mb-8">
              <div className="bg-[#0a0a0a] text-white rounded-xl p-8 md:p-10 border border-gray-800">
                {lesson.metadata?.subtitle && (
                  <p className="text-white/40 text-sm mb-4">{lesson.metadata.subtitle}</p>
                )}
                {lesson.content && (
                  <div
                    className="text-white/70 leading-relaxed text-base"
                    dangerouslySetInnerHTML={{ __html: simpleMarkdown(lesson.content) }}
                  />
                )}
                {lesson.metadata?.items && (
                  <div className="mt-4 space-y-3">
                    {lesson.metadata.items.map((item: string, i: number) => (
                      <div key={i} className="flex gap-3 text-white/70">
                        <span className="text-white/30 font-mono shrink-0">{i + 1}</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                )}
                {lesson.metadata?.stats && (
                  <div className="mt-4 border border-white/10 rounded-lg p-4">
                    {lesson.metadata.stats.map((s: { label: string; value: string }, i: number) => (
                      <div key={i} className="flex justify-between border-b border-white/10 py-2 last:border-0 text-sm">
                        <span className="text-white/40">{s.label}</span>
                        <span className="text-white/80">{s.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-4 flex justify-end">
                <a
                  href={`/course/${slug}/present#${slideIndex}`}
                  className="px-4 py-2 bg-gray-900 text-white/70 hover:text-white border border-gray-700 rounded-lg text-sm transition-colors"
                >
                  ▶ Present from here
                </a>
              </div>
            </div>
          )}

          {/* Video content */}
          {lesson.contentType === 'video' && lesson.metadata?.videoUrl && (
            <div className="aspect-video mb-6 bg-black rounded-lg overflow-hidden">
              <iframe
                src={lesson.metadata.videoUrl}
                className="w-full h-full"
                allowFullScreen
              />
            </div>
          )}

          {/* Markdown content (non-slide) */}
          {lesson.content && lesson.contentType !== 'slide' && (
            <div
              className="prose prose-lg dark:prose-invert max-w-none mb-8"
              dangerouslySetInnerHTML={{ __html: simpleMarkdown(lesson.content) }}
            />
          )}

          {/* Exercise metadata */}
          {lesson.contentType === 'exercise' && lesson.metadata?.instructions && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-8">
              <h3 className="font-semibold mb-2">📋 Instructions</h3>
              <div
                className="prose dark:prose-invert"
                dangerouslySetInnerHTML={{ __html: simpleMarkdown(lesson.metadata.instructions) }}
              />
            </div>
          )}

          {/* Navigation + Complete */}
          <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-800 pt-6 mt-8">
            <div>
              {prevLesson && (
                <Link
                  href={`/course/${slug}/${prevLesson.id}`}
                  className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  ← {prevLesson.title}
                </Link>
              )}
            </div>
            <div className="flex gap-3">
              {currentProgress?.status !== 'completed' && (
                <button
                  onClick={markComplete}
                  disabled={completing}
                  className="px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50"
                >
                  {completing ? 'Saving...' : '✓ Mark Complete'}
                </button>
              )}
              {nextLesson && (
                <Link
                  href={`/course/${slug}/${nextLesson.id}`}
                  className="px-5 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 text-sm font-medium"
                >
                  Next →
                </Link>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}


