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

interface StudentsData {
  courseTitle: string;
  totalStudents: number;
  totalLessons: number;
  students: Student[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortDid(did: string): string {
  if (did.startsWith('did:email:')) return did.replace('did:email:', '').replace(/_at_/g, '@').replace(/_/g, '.');
  if (did.length > 30) return did.slice(0, 16) + '…' + did.slice(-8);
  return did;
}

export default function StudentsPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [data, setData] = useState<StudentsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/courses/${slug}/students`, { credentials: 'include' });
        if (!res.ok) {
          setError(res.status === 403 ? 'Not authorized' : 'Failed to load');
          return;
        }
        setData(await res.json());
      } catch {
        setError('Failed to load');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slug]);

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>;
  if (error) return <div className="container mx-auto px-4 py-16 text-center text-red-400">{error}</div>;
  if (!data) return null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-6 text-sm">
          <Link href="/dashboard" className="text-amber-500 hover:underline">← My Courses</Link>
          <span className="mx-2 text-gray-400">/</span>
          <Link href={`/dashboard/${slug}`} className="text-amber-500 hover:underline">{data.courseTitle}</Link>
          <span className="mx-2 text-gray-400">/</span>
          <span className="text-gray-500">Students</span>
        </div>

        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Enrolled Students</h1>
          <div className="flex gap-4 text-sm text-gray-500">
            <span>{data.totalStudents} student{data.totalStudents !== 1 ? 's' : ''}</span>
            <span>{data.totalLessons} lesson{data.totalLessons !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {data.students.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500">
            <div className="text-4xl mb-4">👥</div>
            <p>No students enrolled yet.</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
                  <th className="px-5 py-3 font-medium text-gray-500">Student</th>
                  <th className="px-5 py-3 font-medium text-gray-500">Enrolled</th>
                  <th className="px-5 py-3 font-medium text-gray-500">Progress</th>
                  <th className="px-5 py-3 font-medium text-gray-500 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {data.students.map((student, i) => (
                  <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-5 py-3">
                      <span className="font-mono text-xs" title={student.studentDid}>
                        {shortDid(student.studentDid)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-500" title={new Date(student.enrolledAt).toLocaleString()}>
                      {timeAgo(student.enrolledAt)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden max-w-[120px]">
                          <div
                            className="h-full bg-amber-500 rounded-full transition-all"
                            style={{ width: `${student.progress.percentage}%` }}
                          />
                        </div>
                        <span className="text-gray-500 text-xs">
                          {student.progress.completed}/{student.progress.total}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {student.completedAt ? (
                        <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
                          ✓ Complete
                        </span>
                      ) : student.progress.completed > 0 ? (
                        <span className="text-amber-500 text-xs font-medium">In progress</span>
                      ) : (
                        <span className="text-gray-400 text-xs">Enrolled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
