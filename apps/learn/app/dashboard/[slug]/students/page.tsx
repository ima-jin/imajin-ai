'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { apiFetch } from '@imajin/config';

interface Student {
  studentDid: string;
  displayName: string | null;
  email: string | null;
  handle: string | null;
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
        const res = await apiFetch(`/api/courses/${slug}/students`, { credentials: 'include' });
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

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-secondary">Loading...</div>;
  if (error) return <div className="container mx-auto px-4 py-16 text-center text-red-400">{error}</div>;
  if (!data) return null;

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-6 text-sm">
          <Link href="/dashboard" className="text-imajin-orange:underline">← My Courses</Link>
          <span className="mx-2 text-secondary">/</span>
          <Link href={`/dashboard/${slug}`} className="text-imajin-orange:underline">{data.courseTitle}</Link>
          <span className="mx-2 text-secondary">/</span>
          <span className="text-secondary">Students</span>
        </div>

        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Enrolled Students</h1>
          <div className="flex gap-4 text-sm text-secondary">
            <span>{data.totalStudents} student{data.totalStudents !== 1 ? 's' : ''}</span>
            <span>{data.totalLessons} lesson{data.totalLessons !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {data.students.length === 0 ? (
          <div className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 p-8 text-center text-secondary">
            <div className="text-4xl mb-4">👥</div>
            <p>No students enrolled yet.</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 dark:border-white/10 text-left">
                  <th className="px-5 py-3 font-medium text-secondary">Student</th>
                  <th className="px-5 py-3 font-medium text-secondary">Enrolled</th>
                  <th className="px-5 py-3 font-medium text-secondary">Progress</th>
                  <th className="px-5 py-3 font-medium text-secondary text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 dark:divide-white/10/50">
                {data.students.map((student, i) => (
                  <tr key={i} className="hover:bg-surface-elevated dark:hover:bg-surface-elevated/50">
                    <td className="px-5 py-3">
                      <div>
                        {student.displayName && (
                          <div className="font-medium text-sm">{student.displayName}</div>
                        )}
                        {student.email && (
                          <div className="text-xs text-secondary">{student.email}</div>
                        )}
                        {!student.displayName && !student.email && (
                          <span className="font-mono text-xs" title={student.studentDid}>
                            {shortDid(student.studentDid)}
                          </span>
                        )}
                        {(student.displayName || student.email) && (
                          <span className="font-mono text-[10px] text-secondary" title={student.studentDid}>
                            {shortDid(student.studentDid)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-secondary" title={new Date(student.enrolledAt).toLocaleString()}>
                      {timeAgo(student.enrolledAt)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2 bg-surface-elevated dark:bg-surface-elevated rounded-full overflow-hidden max-w-[120px]">
                          <div
                            className="h-full bg-imajin-orange rounded-full transition-all"
                            style={{ width: `${student.progress.percentage}%` }}
                          />
                        </div>
                        <span className="text-secondary text-xs">
                          {student.progress.completed}/{student.progress.total}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {student.completedAt ? (
                        <span className="inline-flex items-center gap-1 text-success text-xs font-medium">
                          ✓ Complete
                        </span>
                      ) : student.progress.completed > 0 ? (
                        <span className="text-imajin-orange text-xs font-medium">In progress</span>
                      ) : (
                        <span className="text-secondary text-xs">Enrolled</span>
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
