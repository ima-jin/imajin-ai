'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import KeyAuthTab from './components/KeyAuthTab';
import PasswordAuthTab from './components/PasswordAuthTab';
import MfaGate from './components/MfaGate';

type Tab = 'key' | 'password';

interface MfaState {
  methods: string[];
  challengeToken: string;
  did: string;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get('next');
  const [activeTab, setActiveTab] = useState<Tab>('key');
  const [mfaState, setMfaState] = useState<MfaState | null>(null);

  useEffect(() => {
    // If localStorage says logged in, verify the session is still valid
    const storedDid = localStorage.getItem('imajin_did');
    if (storedDid) {
      fetch('/api/session', { credentials: 'include' })
        .then(res => {
          if (res.ok) {
            window.location.href = nextUrl || '/';
          } else {
            localStorage.removeItem('imajin_did');
            localStorage.removeItem('imajin_keypair');
          }
        })
        .catch(() => {});
    }
  }, [nextUrl]);

  function handleSuccess(_did: string) {
    window.location.href = nextUrl || '/';
  }

  function handleMfaRequired(data: MfaState) {
    setMfaState(data);
  }

  if (mfaState) {
    return (
      <MfaGate
        {...mfaState}
        nextUrl={nextUrl}
        onSuccess={handleSuccess}
        onCancel={() => setMfaState(null)}
      />
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-white">Sign in</h1>
        <p className="text-gray-400 text-center mb-6">Your key is your identity</p>

        {/* Tab selector */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('key')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${activeTab === 'key' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`}
          >
            Import / Paste Key
          </button>
          <button
            onClick={() => setActiveTab('password')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${activeTab === 'password' ? 'bg-[#F59E0B] text-black font-medium' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`}
          >
            Password
          </button>
        </div>

        {activeTab === 'key' && (
          <KeyAuthTab
            nextUrl={nextUrl}
            onMfaRequired={handleMfaRequired}
            onSuccess={handleSuccess}
          />
        )}
        {activeTab === 'password' && (
          <PasswordAuthTab
            nextUrl={nextUrl}
            onMfaRequired={handleMfaRequired}
            onSuccess={handleSuccess}
          />
        )}

        {/* Register link */}
        <div className="mt-6 p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <p className="text-sm text-gray-400">
            <strong className="text-white">New here?</strong>
            <br />
            <a href="/register" className="text-[#F59E0B] hover:underline mt-1 inline-block">
              Create an identity →
            </a>
          </p>
        </div>

        <div className="mt-4 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg">
          <p className="text-xs text-[#F59E0B]">Your private key never leaves your device.</p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <Suspense fallback={<div className="text-center text-gray-400">Loading...</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
