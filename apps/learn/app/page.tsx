'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ImajinFooter } from '@imajin/ui';

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
  moduleCount: number;
  lessonCount: number;
}

export default function DiscoveryPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    async function loadCourses() {
      try {
        const res = await fetch('/api/courses?status=published');
        if (res.ok) {
          const data = await res.json();
          setCourses(data.courses);
        }
      } catch (e) {
        console.error('Failed to load courses:', e);
      } finally {
        setLoading(false);
      }
    }
    loadCourses();
  }, []);

  const filtered = courses.filter(c =>
    c.title.toLowerCase().includes(search.toLowerCase()) ||
    c.description?.toLowerCase().includes(search.toLowerCase()) ||
    c.tags?.some(t => t.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <div className="text-6xl mb-4">📚</div>
            <h1 className="text-4xl font-bold mb-4">learn.imajin.ai</h1>
            <p className="text-lg text-gray-600 dark:text-gray-400">
              Courses and lessons from creators on the sovereign network
            </p>
          </div>

          {/* Search */}
          <div className="mb-8">
            <input
              type="text"
              placeholder="Search courses by title, description, or tag..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            />
          </div>

          {/* Course Grid */}
          {loading ? (
            <div className="text-center py-12 text-gray-500">Loading courses...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 mb-4">
                {search ? 'No courses match your search.' : 'No courses available yet.'}
              </p>
              <p className="text-sm text-gray-400">
                Are you a creator? <Link href="/dashboard" className="text-amber-500 hover:underline">Create your first course</Link>
              </p>
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {filtered.map(course => (
                <Link
                  key={course.id}
                  href={`/course/${course.slug}`}
                  className="block bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-lg transition-shadow"
                >
                  {course.imageUrl && (
                    <div className="aspect-video bg-gray-100 dark:bg-gray-700">
                      <img src={course.imageUrl} alt={course.title} className="w-full h-full object-cover" />
                    </div>
                  )}
                  <div className="p-5">
                    <h3 className="font-semibold text-lg mb-2">{course.title}</h3>
                    {course.description && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 line-clamp-2">
                        {course.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-sm text-gray-500">
                      <span>{course.moduleCount} modules · {course.lessonCount} lessons</span>
                      <span className="font-medium">
                        {course.price === 0 ? (
                          <span className="text-green-600 dark:text-green-400">Free</span>
                        ) : (
                          `$${(course.price / 100).toFixed(2)}`
                        )}
                      </span>
                    </div>
                    {course.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-3">
                        {course.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      <ImajinFooter />
    </div>
  );
}
