import { notFound } from 'next/navigation';
import Link from 'next/link';

interface PageProps {
  params: { handle: string };
}

async function getCreatorCourses(handle: string) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3103';

  try {
    // Resolve handle → DID
    const identityRes = await fetch(`${authUrl}/api/identity/${handle}`, { cache: 'no-store' });
    if (!identityRes.ok) return null;
    const identity = await identityRes.json();

    // Get creator's published courses
    const coursesRes = await fetch(
      `${baseUrl}/api/courses?creator_did=${encodeURIComponent(identity.did)}&status=published`,
      { cache: 'no-store' }
    );
    if (!coursesRes.ok) return null;
    const data = await coursesRes.json();

    return {
      identity,
      courses: data.courses,
    };
  } catch (error) {
    console.error('Failed to fetch creator courses:', error);
    return null;
  }
}

export default async function CreatorCoursesPage({ params }: PageProps) {
  if (params.handle.includes('.') || params.handle === 'favicon') {
    notFound();
  }

  const data = await getCreatorCourses(params.handle);

  if (!data) {
    notFound();
  }

  const { identity, courses } = data;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        {/* Creator info */}
        <div className="text-center mb-12">
          {identity.avatar && (
            <img src={identity.avatar} alt={identity.name} className="w-20 h-20 rounded-full mx-auto mb-4 object-cover" />
          )}
          <h1 className="text-2xl font-bold">{identity.name || params.handle}</h1>
          <p className="text-gray-500">@{params.handle}</p>
          {identity.bio && <p className="text-gray-600 dark:text-gray-400 mt-2 max-w-lg mx-auto">{identity.bio}</p>}
        </div>

        {/* Courses */}
        {courses.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p>No published courses yet.</p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {courses.map((course: any) => (
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
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 line-clamp-2">{course.description}</p>
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
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
