'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ImajinFooter } from '@imajin/ui';

export default function CoffeePage() {
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
    <main className="min-h-screen bg-gradient-to-b from-amber-50 to-orange-50 dark:from-gray-900 dark:to-gray-800 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <img
            src="/images/logo-kanji.svg"
            alt="今人"
            className="w-24 h-24 mx-auto mb-4"
          />
          <img
            src="/images/logo.svg"
            alt="Imajin"
            className="h-10 mx-auto mb-4"
          />
          <p className="text-gray-500">Sovereign support pages for creators.</p>
        </div>

        {/* Value prop */}
        <div className="bg-orange-100 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-800 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold mb-3 text-orange-800 dark:text-orange-200">Create your own support page</h2>
          <div className="text-orange-900 dark:text-orange-100 space-y-3">
            <p>
              Accept tips from your community. Keep 100% of the relationship.
              No platform fees, no middlemen, no lock-in.
            </p>
            <p>
              Your support page lives at <strong>coffee.imajin.ai/yourhandle</strong> —
              sovereign infrastructure you control.
            </p>
          </div>
        </div>

        {/* Why Coffee */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Why Coffee?</h2>

          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="text-2xl">☕</div>
              <div>
                <h3 className="font-semibold">Your page, your terms</h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm">Set your own message, amounts, and story. No templates forcing your voice into a box.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="text-2xl">💸</div>
              <div>
                <h3 className="font-semibold">No platform fees</h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm">Stripe processes the payment. You keep everything minus Stripe's standard fee. We take nothing.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="text-2xl">🔗</div>
              <div>
                <h3 className="font-semibold">Integrates with Imajin</h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm">Connect your profile, links page, and events. One identity across the sovereign network.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="text-2xl">🔒</div>
              <div>
                <h3 className="font-semibold">You own the data</h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm">Supporter emails, transaction history — yours. No surveillance, no profiling.</p>
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 mb-6 text-center">
          <h3 className="text-xl font-bold mb-2">Ready to get started?</h3>
          <p className="text-gray-500 mb-4">Create your sovereign support page in minutes.</p>
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

        <ImajinFooter className="mt-8" />
      </div>
    </main>
  );
}
