'use client';

import { useState, useEffect } from 'react';
import { buildPublicUrl } from '@imajin/config';
import Link from 'next/link';
import { ImajinFooter } from '@imajin/ui';

export default function Home() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const AUTH_URL = buildPublicUrl('auth');

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
    <div className="min-h-screen bg-surface-base">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-6xl mb-4">🔗</div>

          <h1 className="text-4xl font-bold mb-4">
            links.imajin.ai
          </h1>

          <p className="text-xl text-muted dark:text-secondary mb-8">
            Sovereign link-in-bio pages.
            <br />
            Your links. Your data. No tracking.
          </p>

          {/* CTA */}
          <div className="flex justify-center mb-12">
            {!checkingAuth && (
              isLoggedIn ? (
                <Link href="/edit" className="inline-block px-8 py-4 bg-imajin-orange text-primary font-semibold text-lg hover:brightness-110">
                  Go to Dashboard →
                </Link>
              ) : (
                <a href={`${AUTH_URL}/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin + '/edit' : '/edit')}`} className="inline-block px-8 py-4 bg-imajin-orange text-primary font-semibold text-lg hover:brightness-110">
                  Sign In to Get Started
                </a>
              )
            )}
          </div>

          <div className="bg-white dark:bg-surface-elevated p-8 mb-8 text-left">
            <h2 className="text-2xl font-semibold mb-4 text-center">Why Links?</h2>

            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="text-2xl">🚫</div>
                <div>
                  <h3 className="font-semibold">No invasive tracking</h3>
                  <p className="text-secondary text-sm">We count clicks, not people. No fingerprinting, no cookies, no profiles.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🎨</div>
                <div>
                  <h3 className="font-semibold">Custom themes</h3>
                  <p className="text-secondary text-sm">Built-in presets or customize your own colors and style.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">⚡</div>
                <div>
                  <h3 className="font-semibold">Fast & simple</h3>
                  <p className="text-secondary text-sm">No bloat. Just your links, loading instantly.</p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="text-2xl">🔗</div>
                <div>
                  <h3 className="font-semibold">Integrates with Imajin</h3>
                  <p className="text-secondary text-sm">Connect your profile, coffee page, and more.</p>
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
