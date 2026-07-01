'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';

interface IdentityContextType {
  did: string | null;
  handle: string | null;
  type: string | null;
  isLoggedIn: boolean;
  loading: boolean;
  logout: () => Promise<void>;
}

const IdentityContext = createContext<IdentityContextType | undefined>(undefined);

export function IdentityProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [did, setDid] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkSession() {
      try {
        const res = await fetch('/auth/api/session');
        if (res.ok) {
          const data = await res.json();
          setDid(data.did);
          setHandle(data.handle || null);
          setType(data.type || null);
          setIsLoggedIn(true);
        }
      } catch (e) {
        console.error('Session check failed:', e);
      } finally {
        setLoading(false);
      }
    }
    checkSession();
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/auth/api/logout', { method: 'POST' });
    } catch {}
    setDid(null);
    setHandle(null);
    setType(null);
    setIsLoggedIn(false);
  }, []);

  const value = useMemo(
    () => ({ did, handle, type, isLoggedIn, loading, logout }),
    [did, handle, type, isLoggedIn, loading, logout],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity() {
  const context = useContext(IdentityContext);
  if (!context) throw new Error('useIdentity must be used within IdentityProvider');
  return context;
}
