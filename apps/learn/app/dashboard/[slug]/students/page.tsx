'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface Student {
  studentDid: string;
  enrolledAt: string;
  completedAt: string | null;
  progress: { total: number; completed: number; percentage: number };
}

export default function StudentsPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [course, setCourse] = useState<any>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        // Get course details
        const courseRes = await fetch(`/api/courses/${slug}`, { credentials: 'include' });
        if (courseRes.ok) setCourse(await courseRes.json());

        // TODO: Need a dedicated endpoint for listing enrolled students
        // For now, this page is a placeholder
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slug]);

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-6 text-sm">
          <Link href="/dashboard" className="text-amber-500 hover:underline">← My Courses</Link>
          <span className="mx-2 text-gray-400">/</span>
          <Link href={`/dashboard/${slug}`} className="text-amber-500 hover:underline">{course?.title || slug}</Link>
          <span className="mx-2 text-gray-400">/</span>
          <span className="text-gray-500">Students</span>
        </div>

        <h1 className="text-2xl font-bold mb-6">Enrolled Students</h1>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500">
          <div className="text-4xl mb-4">👥</div>
          <p>Student list endpoint coming soon.</p>
          <p className="text-sm mt-2">Enrollment data is tracked — this view will show enrolled students with their progress.</p>
        </div>
      </div>
    </div>
  );
}
