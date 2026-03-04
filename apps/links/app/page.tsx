'use client';

import { useState, useEffect } from 'react';
import { ImajinFooter } from '@imajin/ui';

export default function Home() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const AUTH_URL = process.env.NEXT_PUBLIC_SERVICE_PREFIX + 'auth.' + process.env.NEXT_PUBLIC_DOMAIN;

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch(`${AUTH_URL}/api/session`, { credentials: 'include' });
        setIsLoggedIn(res.ok);
      } catch { setIsLoggedIn(false); }
      finally { setCheckingAuth(false); }
    }
    checkAuth();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-6xl mb-4">🔗</div>

          <h1 className="text-4xl font-bold mb-4">
            links.imajin.ai
          </h1>

          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
            Sovereign link-in-bio pages.
            <br />
            Your links. Your data. No tracking.
          </p>

          {/* CTA */}
          <div className="flex justify-center mb-12">
            {!checkingAuth && (
              isLoggedIn ? (
                <a href="/dashboard" className="inline-block px-8 py-4 bg-orange-500 text-white rounded-xl font-semibold text-lg hover:bg-orange-600 transition hover:shadow-lg">
                  Go to Dashboard →
                </a>
              ) : (
                <a href={`${AUTH_URL}?redirect=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin + '/dashboard' : '/dashboard')}`} className="inline-block px-8 py-4 bg-orange-500 text-white rounded-xl font-semibold text-lg hover:bg-orange-600 transition hover:shadow-lg">
                  Sign In to Get Started
                </a>
              )
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 mb-8 text-left">
            <h2 className="text-2xl font-semibold mb-4 text-center">Why Links?</h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="text-2xl">🚫</div>
                <div>
                  <h3 className="font-semibold">No invasive tracking</h3>
                  <p className="text-gray-500 text-sm">We count clicks, not people. No fingerprinting, no cookies, no profiles.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🎨</div>
                <div>
                  <h3 className="font-semibold">Custom themes</h3>
                  <p className="text-gray-500 text-sm">Built-in presets or customize your own colors and style.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">⚡</div>
                <div>
                  <h3 className="font-semibold">Fast & simple</h3>
                  <p className="text-gray-500 text-sm">No bloat. Just your links, loading instantly.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🔗</div>
                <div>
                  <h3 className="font-semibold">Integrates with Imajin</h3>
                  <p className="text-gray-500 text-sm">Connect your profile, coffee page, and more.</p>
                </div>
              </div>
            </div>
          </div>

          <ImajinFooter className="mt-8" />
        </div>
      </div>
    </div>
  );
}
