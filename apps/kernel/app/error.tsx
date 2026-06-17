'use client';

import { useEffect } from 'react';
import Link from 'next/link';

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

async function reportError(error: Error): Promise<void> {
  try {
    const payload = {
      message: error.message || 'React rendering error',
      stack: error.stack || '',
      url: typeof globalThis.window === 'undefined' ? '' : globalThis.location.href,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      componentStack: '',
      timestamp: new Date().toISOString(),
    };

    await fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([payload]),
    });
  } catch {
    // Silently fail — error reporting must not throw
  }
}

export default function ErrorBoundary({ error, reset }: Readonly<ErrorBoundaryProps>) {
  useEffect(() => {
    reportError(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-white dark:bg-[#0a0a0a]">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Something went wrong
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            We encountered an unexpected error. Please try again or return to the home page.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-900 dark:text-white text-sm font-medium rounded-lg transition-colors"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
