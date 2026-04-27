'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@imajin/ui';
import { apiFetch } from '@imajin/config';

interface Lesson {
  id: string;
  title: string;
  contentType: string;
  content: string | null;
  durationMinutes: number | null;
  sortOrder: number;
  metadata: any;
}

interface Module {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
}

interface Course {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  price: number;
  currency: string;
  visibility: string;
  status: string;
  imageUrl: string | null;
  tags: any;
}

export default function CourseEditorPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const slug = params.slug as string;

  const [course, setCourse] = useState<Course | null>(null);
  const [modules, setModules] = useState<(Module & { lessons: Lesson[] })[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Edit states
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPrice, setEditPrice] = useState(0);
  const [editVisibility, setEditVisibility] = useState('public');
  const [editStatus, setEditStatus] = useState('draft');
  const [editEventSlug, setEditEventSlug] = useState('');

  // Module/lesson creation
  const [newModuleTitle, setNewModuleTitle] = useState('');
  const [editingLesson, setEditingLesson] = useState<string | null>(null);
  const [lessonForm, setLessonForm] = useState({ title: '', contentType: 'markdown', content: '', durationMinutes: '' });

  const loadCourse = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/courses/${slug}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setCourse(data);
      setModules(data.modules || []);
      setEditTitle(data.title);
      setEditDescription(data.description || '');
      setEditPrice(data.price || 0);
      setEditVisibility(data.visibility || 'public');
      setEditStatus(data.status || 'draft');
      setEditEventSlug(data.eventSlug || '');
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { loadCourse(); }, [loadCourse]);

  async function saveCourse() {
    setSaving(true);
    try {
      await apiFetch(`/api/courses/${slug}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          description: editDescription,
          price: editPrice,
          visibility: editVisibility,
          status: editStatus,
          eventSlug: editEventSlug || null,
        }),
      });
      await loadCourse();
    } catch (e) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function addModule() {
    if (!newModuleTitle.trim()) return;
    const res = await apiFetch(`/api/courses/${slug}/modules`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newModuleTitle.trim() }),
    });
    if (res.ok) {
      setNewModuleTitle('');
      await loadCourse();
    }
  }

  async function deleteModule(moduleId: string) {
    if (!confirm('Delete this module and all its lessons?')) return;
    await apiFetch(`/api/courses/${slug}/modules/${moduleId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await loadCourse();
  }

  async function addLesson(moduleId: string) {
    const title = prompt('Lesson title:');
    if (!title?.trim()) return;
    const res = await apiFetch(`/api/courses/${slug}/modules/${moduleId}/lessons`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    if (res.ok) await loadCourse();
  }

  async function saveLesson(moduleId: string, lessonId: string) {
    await apiFetch(`/api/courses/${slug}/modules/${moduleId}/lessons/${lessonId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: lessonForm.title,
        contentType: lessonForm.contentType,
        content: lessonForm.content,
        durationMinutes: lessonForm.durationMinutes ? parseInt(lessonForm.durationMinutes) : null,
      }),
    });
    setEditingLesson(null);
    await loadCourse();
  }

  async function deleteLesson(moduleId: string, lessonId: string) {
    if (!confirm('Delete this lesson?')) return;
    await apiFetch(`/api/courses/${slug}/modules/${moduleId}/lessons/${lessonId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await loadCourse();
  }

  function startEditLesson(lesson: Lesson) {
    setEditingLesson(lesson.id);
    setLessonForm({
      title: lesson.title,
      contentType: lesson.contentType,
      content: lesson.content || '',
      durationMinutes: lesson.durationMinutes?.toString() || '',
    });
  }

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-secondary">Loading...</div>;
  if (!course) return <div className="container mx-auto px-4 py-16 text-center text-secondary">Course not found</div>;

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Breadcrumb */}
        <div className="mb-6 text-sm">
          <Link href="/dashboard" className="text-imajin-orange:underline">← My Courses</Link>
          <span className="mx-2 text-secondary">/</span>
          <span className="text-secondary">{course.title}</span>
        </div>

        {/* Course settings */}
        <div className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 p-6 mb-6">
          <h2 className="font-semibold text-lg mb-4">Course Settings</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Title</label>
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Linked Event</label>
              <input
                value={editEventSlug}
                onChange={(e) => setEditEventSlug(e.target.value)}
                placeholder="Event ID (e.g. jins-launch-party)"
                className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
              />
              <p className="text-xs text-secondary mt-1">Shows a &quot;Live Workshop&quot; banner on the course page linking to this event.</p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Price (cents)</label>
                <input
                  type="number"
                  value={editPrice}
                  onChange={(e) => setEditPrice(parseInt(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Visibility</label>
                <select
                  value={editVisibility}
                  onChange={(e) => setEditVisibility(e.target.value)}
                  className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
                >
                  <option value="public">Public</option>
                  <option value="trust-bound">Trust-bound</option>
                  <option value="private">Private</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
                >
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={saveCourse}
                disabled={saving}
                className="px-5 py-2 bg-imajin-orange text-primary bg-imajin-orange font-medium disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <Link
                href={`/course/${slug}`}
                className="px-5 py-2 border border-white/10 dark:border-white/10:bg-surface-elevated dark:hover:bg-surface-elevated text-sm"
              >
                View Public Page
              </Link>
              <Link
                href={`/dashboard/${slug}/students`}
                className="px-5 py-2 border border-white/10 dark:border-white/10:bg-surface-elevated dark:hover:bg-surface-elevated text-sm"
              >
                Students
              </Link>
            </div>
          </div>
        </div>

        {/* Modules & lessons */}
        <div className="mb-6">
          <h2 className="font-semibold text-lg mb-4">Modules & Lessons</h2>

          {modules.map((mod, i) => (
            <div key={mod.id} className="bg-white dark:bg-surface-elevated border border-white/10 dark:border-white/10 mb-4 overflow-hidden">
              <div className="px-5 py-4 border-b border-white/10 dark:border-white/10 flex items-center justify-between">
                <h3 className="font-medium">
                  <span className="text-secondary mr-2">Module {i + 1}</span>
                  {mod.title}
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => addLesson(mod.id)}
                    className="text-xs px-3 py-1 bg-surface-elevated dark:bg-surface-elevated:bg-surface-elevated dark:hover:bg-surface-elevated"
                  >
                    + Lesson
                  </button>
                  <button
                    onClick={() => deleteModule(mod.id)}
                    className="text-xs px-3 py-1 text-error:bg-error/10 dark:hover:bg-red-900/20"
                  >
                    Delete
                  </button>
                </div>
              </div>

              <ul className="divide-y divide-white/10 dark:divide-white/10">
                {mod.lessons.map((lesson) => (
                  <li key={lesson.id} className="px-5 py-3">
                    {editingLesson === lesson.id ? (
                      <div className="space-y-3">
                        <input
                          value={lessonForm.title}
                          onChange={(e) => setLessonForm(f => ({ ...f, title: e.target.value }))}
                          placeholder="Lesson title"
                          className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
                        />
                        <div className="grid grid-cols-2 gap-3">
                          <select
                            value={lessonForm.contentType}
                            onChange={(e) => setLessonForm(f => ({ ...f, contentType: e.target.value }))}
                            className="px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
                          >
                            <option value="markdown">Markdown</option>
                            <option value="exercise">Exercise</option>
                            <option value="slide">Slide</option>
                            <option value="video">Video</option>
                          </select>
                          <input
                            type="number"
                            value={lessonForm.durationMinutes}
                            onChange={(e) => setLessonForm(f => ({ ...f, durationMinutes: e.target.value }))}
                            placeholder="Duration (min)"
                            className="px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
                          />
                        </div>
                        <textarea
                          value={lessonForm.content}
                          onChange={(e) => setLessonForm(f => ({ ...f, content: e.target.value }))}
                          rows={10}
                          placeholder="Lesson content (markdown)"
                          className="w-full px-3 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated font-mono text-sm"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveLesson(mod.id, lesson.id)}
                            className="px-4 py-1.5 bg-success text-primary text-sm:bg-success/80"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingLesson(null)}
                            className="px-4 py-1.5 border border-white/10 dark:border-white/10 text-sm"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-secondary text-sm">{lesson.sortOrder + 1}.</span>
                          <span>{lesson.title}</span>
                          <span className="text-xs text-secondary bg-surface-elevated dark:bg-surface-elevated px-2 py-0.5">
                            {lesson.contentType}
                          </span>
                          {lesson.durationMinutes && (
                            <span className="text-xs text-secondary">{lesson.durationMinutes}m</span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => startEditLesson(lesson)}
                            className="text-xs px-3 py-1 text-imajin-orange bg-imajin-orange/5 dark:hover:bg-imajin-orange/5"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteLesson(mod.id, lesson.id)}
                            className="text-xs px-3 py-1 text-error:bg-error/10 dark:hover:bg-red-900/20"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
                {mod.lessons.length === 0 && (
                  <li className="px-5 py-4 text-center text-secondary text-sm">
                    No lessons yet. Click "+ Lesson" to add one.
                  </li>
                )}
              </ul>
            </div>
          ))}

          {/* Add module */}
          <div className="flex gap-3 mt-4">
            <input
              type="text"
              placeholder="New module title..."
              value={newModuleTitle}
              onChange={(e) => setNewModuleTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addModule()}
              className="flex-1 px-4 py-2 border border-white/10 dark:border-white/10 bg-white dark:bg-surface-elevated"
            />
            <button
              onClick={addModule}
              disabled={!newModuleTitle.trim()}
              className="px-5 py-2 bg-surface-elevated dark:bg-gray-600 text-primary:bg-surface-elevated disabled:opacity-50"
            >
              + Module
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
