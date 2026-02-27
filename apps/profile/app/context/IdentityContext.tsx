'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import * as ed from '@noble/ed25519';

// Base58 encoding for DIDs
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num = num / 58n;
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  return encoded || '1';
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

interface IdentityContextType {
  did: string | null;
  handle: string | null;
  avatar: string | null;
  displayName: string | null;
  isLoggedIn: boolean;
  logout: () => Promise<void>;
  importKeys: (privateKeyHex: string) => Promise<{ success: boolean; error?: string; did?: string; handle?: string }>;
  refreshProfile: () => Promise<void>;
}

const IdentityContext = createContext<IdentityContextType | undefined>(undefined);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [did, setDid] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Check localStorage on mount
  useEffect(() => {
    loadIdentity();
  }, []);

  async function loadIdentity() {
    if (typeof window === 'undefined') return;

    // Check auth session first
    try {
      const authResponse = await fetch('/api/auth/session');
      if (authResponse.ok) {
        const authSession = await authResponse.json();
        setDid(authSession.did);
        setHandle(authSession.handle || null);
        setIsLoggedIn(true);
        return;
      }
      // Auth returned 401/error — clear any stale localStorage
      localStorage.removeItem('imajin_did');
      localStorage.removeItem('imajin_keypair');
    } catch (error) {
      console.error('Failed to check auth session:', error);
      // Network error — fall back to localStorage
      const storedDid = localStorage.getItem('imajin_did');
      const storedKeypair = localStorage.getItem('imajin_keypair');

      if (storedDid && storedKeypair) {
        setDid(storedDid);
        setIsLoggedIn(true);

        try {
          const response = await fetch(`/api/profile/${storedDid}`);
          if (response.ok) {
            const profile = await response.json();
            setHandle(profile.handle || null);
            setAvatar(profile.avatar || null);
            setDisplayName(profile.displayName || null);
          }
        } catch (e) {
          console.error('Failed to fetch profile:', e);
        }
      }
    }
  }

  async function logout() {
    if (typeof window === 'undefined') return;

    // Clear auth session cookie
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Failed to clear auth session:', error);
    }

    // Clear localStorage
    localStorage.removeItem('imajin_did');
    localStorage.removeItem('imajin_keypair');

    setDid(null);
    setHandle(null);
    setAvatar(null);
    setDisplayName(null);
    setIsLoggedIn(false);
  }

  async function importKeys(privateKeyHex: string): Promise<{ success: boolean; error?: string; did?: string; handle?: string }> {
    try {
      // Validate hex format
      if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
        return { success: false, error: 'Invalid private key format. Must be 64 hex characters.' };
      }

      // Derive public key
      const privateKeyBytes = hexToBytes(privateKeyHex);
      const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
      const publicKeyHex = Buffer.from(publicKeyBytes).toString('hex');

      // Generate DID
      const publicKeyBase58 = base58Encode(publicKeyBytes);
      const derivedDid = `did:imajin:${publicKeyBase58}`;

      // Check if profile exists
      const profileResponse = await fetch(`/api/profile/${derivedDid}`);
      if (!profileResponse.ok) {
        return { success: false, error: 'No profile found for this key. Please register first.' };
      }

      const profile = await profileResponse.json();

      // Register/login with auth service (will return existing identity if already registered)
      const payload = JSON.stringify({
        publicKey: publicKeyHex,
        handle: profile.handle || undefined,
        name: profile.displayName,
        type: 'human',
      });
      const msgBytes = new TextEncoder().encode(payload);
      const signatureBytes = await ed.signAsync(msgBytes, privateKeyBytes);
      const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      const authResponse = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: publicKeyHex,
          handle: profile.handle || undefined,
          name: profile.displayName,
          type: 'human',
          signature,
        }),
      });

      if (!authResponse.ok) {
        const authError = await authResponse.json();
        return { success: false, error: `Auth failed: ${authError.error || 'Unknown error'}` };
      }

      // Store in localStorage
      localStorage.setItem('imajin_keypair', JSON.stringify({
        privateKey: privateKeyHex,
        publicKey: publicKeyHex,
      }));
      localStorage.setItem('imajin_did', derivedDid);

      // Update state
      setDid(derivedDid);
      setHandle(profile.handle || null);
      setAvatar(profile.avatar || null);
      setDisplayName(profile.displayName || null);
      setIsLoggedIn(true);

      return { success: true, did: derivedDid, handle: profile.handle };
    } catch (error: any) {
      console.error('Import keys failed:', error);
      return { success: false, error: error.message || 'Failed to import keys' };
    }
  }

  async function refreshProfile() {
    if (!did) return;

    try {
      const response = await fetch(`/api/profile/${did}`);
      if (response.ok) {
        const profile = await response.json();
        setHandle(profile.handle || null);
        setAvatar(profile.avatar || null);
        setDisplayName(profile.displayName || null);
      }
    } catch (error) {
      console.error('Failed to refresh profile:', error);
    }
  }

  return (
    <IdentityContext.Provider
      value={{
        did,
        handle,
        avatar,
        displayName,
        isLoggedIn,
        logout,
        importKeys,
        refreshProfile,
      }}
    >
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  const context = useContext(IdentityContext);
  if (context === undefined) {
    throw new Error('useIdentity must be used within an IdentityProvider');
  }
  return context;
}
