/* eslint-disable no-console */
'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { SlideRenderer, type SlideLesson } from '../../../components/SlideRenderer';
import { apiFetch } from '@imajin/config';

export default function PresentPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [slides, setSlides] = useState<SlideLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialIndex, setInitialIndex] = useState(0);

  // Read initial slide index from URL hash
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash) {
      const index = parseInt(hash, 10);
      if (!isNaN(index) && index >= 0) setInitialIndex(index);
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        // Get course structure + enrollment/creator status
        const courseRes = await apiFetch(`/api/courses/${slug}`, { credentials: 'include' });
        if (!courseRes.ok) {
          setError('Course not found');
          return;
        }
        const course = await courseRes.json();

        // Require enrollment or creator access
        if (!course.isCreator && !course.enrollment) {
          router.replace(`/course/${slug}`);
          return;
        }

        // Collect slide lessons across all modules in order
        const slideList: Array<{ id: string; moduleId: string; title: string; contentType: string }> = [];
        for (const mod of course.modules) {
          for (const lesson of mod.lessons) {
            if (lesson.contentType === 'slide') {
              slideList.push({ ...lesson, moduleId: mod.id });
            }
          }
        }

        if (slideList.length === 0) {
          setError('No slides found in this course');
          return;
        }

        // Fetch full content for each slide lesson in parallel
        const fullSlides = await Promise.all(
          slideList.map(async (s) => {
            try {
              const res = await apiFetch(
                `/api/courses/${slug}/modules/${s.moduleId}/lessons/${s.id}`,
                { credentials: 'include' }
              );
              if (res.ok) return res.json();
            } catch {
              // fall through to stub
            }
            // Fallback: return a stub with just the title
            return { id: s.id, title: s.title, content: null, metadata: null };
          })
        );

        setSlides(fullSlides);
      } catch (e) {
        console.error(e);
        setError('Failed to load slides');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slug, router]);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] text-white flex items-center justify-center">
        <div className="text-white/30 text-sm tracking-widest">LOADING</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 bg-[#0a0a0a] text-white flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-white/40">{error}</p>
          <button
            onClick={() => router.push(`/course/${slug}`)}
            className="text-amber-500 hover:text-amber-400 text-sm"
          >
            ← Back to course
          </button>
        </div>
      </div>
    );
  }

  return (
    <SlideRenderer
      slides={slides}
      initialIndex={initialIndex}
      onExit={() => router.push(`/course/${slug}`)}
    />
  );
}
