import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-surface-surface flex items-center justify-center">
      <div className="text-center text-primary">
        <div className="text-6xl mb-4">🔗</div>
        <h1 className="text-2xl font-bold mb-2">Page Not Found</h1>
        <p className="text-secondary mb-6">
          This links page doesn't exist yet.
        </p>
        <Link 
          href="/"
          className="inline-block px-6 py-2 bg-imajin-blue text-primary:bg-blue-600 transition"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
