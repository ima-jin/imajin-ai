import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="max-w-lg mx-auto text-center py-16">
      <div className="text-6xl mb-4">☕</div>
      <h1 className="text-2xl font-bold mb-2">Page Not Found</h1>
      <p className="text-gray-500 mb-6">
        This coffee page doesn't exist yet.
      </p>
      <Link 
        href="/"
        className="inline-block px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition"
      >
        Go Home
      </Link>
    </div>
  );
}
