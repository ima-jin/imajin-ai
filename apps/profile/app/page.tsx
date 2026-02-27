'use client';

import { useEffect, useState } from 'react';
import { useIdentity } from './context/IdentityContext';
import Link from 'next/link';

export default function Home() {
  const { isLoggedIn, handle, did } = useIdentity();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Give identity context a moment to hydrate
    const timer = setTimeout(() => setLoading(false), 500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!loading && isLoggedIn && (handle || did)) {
      window.location.href = `/${handle || did}`;
    }
  }, [loading, isLoggedIn, handle, did]);

  if (loading || isLoggedIn) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-[#F59E0B] mb-4"></div>
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto text-center py-12">
      <div className="text-6xl mb-4">🟠</div>
      <h1 className="text-4xl font-bold mb-4 text-white">
        Imajin Profiles
      </h1>

      <p className="text-lg text-gray-400 mb-2">
        Sovereign identity on the open network.
      </p>
      <p className="text-sm text-gray-500 mb-8">
        No passwords. No email. You own your keys, you own your identity.
      </p>

      <div className="flex flex-col gap-3 max-w-xs mx-auto">
        <Link
          href="/login"
          className="px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold text-center"
        >
          Login with Key File
        </Link>
        <p className="text-xs text-gray-500">
          Have an invite?{' '}
          <span className="text-gray-400">
            Use the invite link to create your identity.
          </span>
        </p>
      </div>

      <div className="mt-12 text-gray-500 text-sm">
        <p>Part of the <a href="https://imajin.ai" className="text-[#F59E0B] hover:underline">Imajin</a> sovereign stack</p>
      </div>
    </div>
  );
}
