'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useToast, PayoutSetupBanner } from '@imajin/ui';
import { apiFetch, apiUrl } from '@imajin/config';

const PAY_URL = process.env.NEXT_PUBLIC_PAY_URL || 'https://pay.imajin.ai';

interface Course {
  id: string;
  title: string;
  slug: string;
  status: string;
  price: number;
  currency: string;
  enrollmentCount: number;
  moduleCount: number;
  lessonCount: number;
  createdAt: string;
}

const statusColors: Record<string, string> = {
  draft: 'bg-surface-elevated text-muted dark:bg-surface-elevated dark:text-secondary',
  published: 'bg-success/10 text-green-700 dark:bg-success/10 dark:text-success',
  archived: 'bg-error/10 text-error dark:bg-error/10 dark:text-error',
};

export default function DashboardPage() {
  const { toast } = useToast();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [myDid, setMyDid] = useState<string | null>(null);

  useEffect(() => {
    loadCourses();
  }, []);

  async function loadCourses() {
    try {
      const res = await apiFetch('/api/my/teaching', { credentials: 'include' });
      if (res.status === 401) {
        setError('Please sign in to access the dashboard.');
        setLoading(false);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setCourses(data.courses);
        if (data.courses?.[0]?.creatorDid) setMyDid(data.courses[0].creatorDid);
      }
    } catch (e) {
      setError('Failed to load courses');
    } finally {
      setLoading(false);
    }
  }

  async function createCourse() {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch('/api/courses', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (res.ok) {
        const course = await res.json();
        setNewTitle('');
        window.location.href = apiUrl(`/dashboard/${course.slug}`);
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to create course');
      }
    } catch (e) {
      toast.error('Failed to create course');
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-secondary">Loading...</div>;

  if (error) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <p className="text-secondary">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {myDid && (
          <PayoutSetupBanner
            did={myDid}
            payUrl={PAY_URL}
            message="Connect Stripe to receive course revenue"
          />
        )}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">My Courses</h1>
        </div>

        {/* Create new course */}
        <div className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 p-5 mb-8">
          <h2 className="font-medium mb-3">Create a new course</h2>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Course title..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createCourse()}
              className="flex-1 px-4 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated focus:ring-2 focus:ring-imajin-purple focus:border-transparent"
            />
            <button
              onClick={createCourse}
              disabled={creating || !newTitle.trim()}
              className="px-5 py-2 bg-imajin-orange text-primary bg-imajin-orange font-medium disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>

        {/* Course list */}
        {courses.length === 0 ? (
          <div className="text-center py-12 text-secondary">
            <div className="text-4xl mb-4">📚</div>
            <p>No courses yet. Create your first one above!</p>
          </div>
        ) : (
          <div className="space-y-4">
            {courses.map(course => (
              <Link
                key={course.id}
                href={`/dashboard/${course.slug}`}
                className="block bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 p-5 transition-"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-lg">{course.title}</h3>
                    <div className="flex items-center gap-3 mt-2 text-sm text-secondary">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[course.status] || statusColors.draft}`}>
                        {course.status}
                      </span>
                      <span>{course.moduleCount} modules</span>
                      <span>·</span>
                      <span>{course.lessonCount} lessons</span>
                      <span>·</span>
                      <span>{course.enrollmentCount} students</span>
                    </div>
                  </div>
                  <div className="text-sm text-secondary">
                    {course.price === 0 ? 'Free' : `$${(course.price / 100).toFixed(2)}`}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
