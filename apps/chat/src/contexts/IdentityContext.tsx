'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export interface Identity {
  did: string;
  handle?: string;
  type: string;
  name?: string;
}

interface IdentityContextType {
  identity: Identity | null;
  loading: boolean;
  error: string | null;
}

const IdentityContext = createContext<IdentityContextType>({
  identity: null,
  loading: true,
  error: null,
});

export function useIdentity() {
  return useContext(IdentityContext);
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function checkSession() {
      try {
        const res = await fetch('/api/session');
        if (res.ok) {
          const data = await res.json();
          // Session API returns { identity: { id, handle, name, type } }
          const raw = data.identity || data;
          setIdentity({
            did: raw.did || raw.id,
            handle: raw.handle,
            type: raw.type || 'human',
            name: raw.name,
          });
        } else {
          setIdentity(null);
        }
      } catch {
        setError('Failed to check session');
        setIdentity(null);
      } finally {
        setLoading(false);
      }
    }
    checkSession();
  }, []);

  return (
    <IdentityContext.Provider value={{ identity, loading, error }}>
      {children}
    </IdentityContext.Provider>
  );
}

/**
 * Login prompt component - shown when not authenticated
 */
export function LoginPrompt() {
  const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 
    `${process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://dev-'}auth.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}`;
  const chatUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://dev-chat.imajin.ai';

  return (
    <div className="max-w-md mx-auto mt-20 text-center">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
        <h2 className="text-2xl font-bold mb-2">Sign in to Chat</h2>
        <p className="text-gray-500 dark:text-gray-400 mb-6">
          You need an Imajin identity to use encrypted messaging.
        </p>
        <a
          href={`${authUrl}/login?next=${encodeURIComponent(chatUrl + '/conversations')}`}
          className="inline-block px-6 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition font-medium"
        >
          Sign In
        </a>
        <p className="mt-4 text-sm text-gray-400">
          Don&apos;t have an identity?{' '}
          <a href={`${authUrl}/register`} className="text-orange-500 hover:underline">
            Create one
          </a>
        </p>
      </div>
    </div>
  );
}
