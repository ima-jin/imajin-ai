'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { normalizeHandleInput } from '@imajin/config';
import * as ed from '@noble/ed25519';
import { useIdentity } from '../context/IdentityContext';
import { ImageUpload } from '../components/ImageUpload';

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

async function generateKeypair() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  return {
    privateKey: Buffer.from(privateKey).toString('hex'),
    publicKey: Buffer.from(publicKey).toString('hex'),
    publicKeyBytes: publicKey,
  };
}

type Step = 'form' | 'creating' | 'success' | 'error' | 'no-invite';
type HandleCheckStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';
type AvatarMode = 'emoji' | 'image';

export default function RegisterPageWrapper() {
  return (
    <Suspense fallback={<div className="max-w-md mx-auto text-center py-12 text-secondary">Loading...</div>}>
      <RegisterPage />
    </Suspense>
  );
}

function RegisterPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteCode = searchParams.get('invite');
  const redirectUrl = searchParams.get('next');
  const { isLoggedIn, handle: loggedInHandle, did, importKeys } = useIdentity();
  const inviteGateDisabled = process.env.NEXT_PUBLIC_DISABLE_INVITE_GATE === 'true';
  const [step, setStep] = useState<Step>((inviteCode || inviteGateDisabled) ? 'form' : 'no-invite');
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<any>(null);

  // Form state
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('👤');
  const [avatarMode, setAvatarMode] = useState<AvatarMode>('emoji');
  const [tempDid, setTempDid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Handle availability checking
  const [handleStatus, setHandleStatus] = useState<HandleCheckStatus>('idle');
  const [handleMessage, setHandleMessage] = useState('');
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  // Show redirect banner if already logged in
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (isLoggedIn && did) {
      setShowBanner(true);
    }
  }, [isLoggedIn, did]);

  // Debounced handle availability check
  useEffect(() => {
    if (!handle || handle.length < 3) {
      setHandleStatus('idle');
      setHandleMessage('');
      return;
    }

    // Clear existing timer
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Set checking status
    setHandleStatus('checking');

    // Debounce for 500ms
    debounceTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/profile/api/handle-check?handle=${encodeURIComponent(handle)}`);
        const data = await response.json();

        if (data.available) {
          setHandleStatus('available');
          setHandleMessage('Available');
        } else {
          setHandleStatus(data.reason === 'invalid' ? 'invalid' : 'taken');
          setHandleMessage(data.message || 'Not available');
        }
      } catch (error) {
        console.error('Handle check failed:', error);
        setHandleStatus('idle');
      }
    }, 500);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [handle]);

  function copyDid(did: string) {
    navigator.clipboard.writeText(did);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // TODO: Password manager integration (Phase 2 - passkeys)
  async function saveToPasswordManager() {
    const keypair = localStorage.getItem('imajin_keypair');
    const did = localStorage.getItem('imajin_did');
    if (!keypair || !did) return;

    const privateKey = JSON.parse(keypair).privateKey;

    // Try Credential Management API first
    if ('credentials' in navigator && 'PasswordCredential' in window) {
      try {
        const cred = new (window as any).PasswordCredential({
          id: did,
          password: privateKey,
          name: profile?.handle ? `@${profile.handle}` : 'Imajin Identity',
        });
        await navigator.credentials.store(cred);
        return;
      } catch (e) {
        console.log('Credential API failed, falling back');
      }
    }

    // Fallback: open a small window with a real form that triggers password managers
    const w = window.open('', '_blank', 'width=1,height=1');
    if (w) {
      w.document.write(`
        <html><body>
          <form id="f" action="javascript:void(0)">
            <input type="text" name="username" autocomplete="username" value="${did}" />
            <input type="password" name="password" autocomplete="current-password" value="${privateKey}" />
            <button type="submit">Save</button>
          </form>
          <script>
            document.getElementById('f').submit();
            setTimeout(() => window.close(), 3000);
          </script>
        </body></html>
      `);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStep('creating');
    setError('');

    try {
      // 1. Generate keypair
      const keypair = await generateKeypair();
      const publicKeyBase58 = base58Encode(keypair.publicKeyBytes);
      const did = `did:imajin:${publicKeyBase58}`;

      // 2. Sign payload for auth service
      const payload = JSON.stringify({
        publicKey: keypair.publicKey,
        handle: handle || undefined,
        name: displayName,
        scope: 'actor',
        subtype: 'human',
      });
      const msgBytes = new TextEncoder().encode(payload);
      const privateKeyBytes = new Uint8Array(keypair.privateKey.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
      const signatureBytes = await ed.signAsync(msgBytes, privateKeyBytes);
      const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      // 3. Register with auth service (sets JWT cookie)
      const authResponse = await fetch('/auth/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey,
          handle: handle || undefined,
          name: displayName,
          scope: 'actor',
          subtype: 'human',
          signature,
          inviteCode: inviteCode || undefined,
        }),
      });

      const authData = await authResponse.json();

      if (!authResponse.ok) {
        throw new Error(authData.error || 'Auth registration failed');
      }

      // 4. Register profile
      const profileResponse = await fetch('/profile/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: keypair.publicKey,
          handle: handle || undefined,
          displayName,
          bio: bio || undefined,
          avatar: avatar || undefined,
        }),
      });

      const profileData = await profileResponse.json();

      if (!profileResponse.ok) {
        throw new Error(profileData.error || 'Profile registration failed');
      }

      // 5. Store keypair in localStorage and update identity context
      localStorage.setItem('imajin_keypair', JSON.stringify({
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
      }));
      localStorage.setItem('imajin_did', did);

      // Import keys into identity context to update navbar
      await importKeys(keypair.privateKey);

      setProfile(profileData);
      setStep('success');

    } catch (err: any) {
      console.error('Registration error:', err);
      setError(err.message || 'Something went wrong');
      setStep('error');
    }
  }

  // Generate temporary DID for image upload before registration
  useEffect(() => {
    async function generateTempDid() {
      const keypair = await generateKeypair();
      const publicKeyBase58 = base58Encode(keypair.publicKeyBytes);
      setTempDid(`did:imajin:${publicKeyBase58}`);
    }
    if (avatarMode === 'image' && !tempDid) {
      generateTempDid();
    }
  }, [avatarMode, tempDid]);

  function downloadKeys() {
    const keypair = localStorage.getItem('imajin_keypair');
    const did = localStorage.getItem('imajin_did');
    if (!keypair || !did) return;

    const backup = {
      did,
      keypair: JSON.parse(keypair),
      exportedAt: new Date().toISOString(),
      warning: 'Keep this file safe. Anyone with access can control your identity.',
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `imajin-keys-${did.slice(-8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (step === 'no-invite') {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-[#0a0a0a] border border-white/10 p-8">
          <div className="text-6xl mb-4">🔒</div>
          <h1 className="text-2xl font-bold mb-2 text-primary font-mono">Invite Only</h1>
          <p className="text-secondary mb-6">
            Imajin is an invite-only network. You need an invite link from an existing member to create an account.
          </p>
          <p className="text-secondary text-sm mb-6">
            Already have an account?
          </p>
          <a
            href="/auth/login"
            className="inline-block px-6 py-3 bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-semibold"
          >
            Login
          </a>
        </div>
      </div>
    );
  }

  if (step === 'success' && profile) {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-[#0a0a0a] border border-white/10 p-8">
          <div className="text-6xl mb-4">🟠</div>
          <h1 className="text-2xl font-bold mb-2 text-primary font-mono">Welcome to Imajin!</h1>
          <p className="text-secondary mb-6">
            Your sovereign identity has been created.
          </p>

          <div
            onClick={() => copyDid(profile.did)}
            className="bg-surface-base/50 p-4 mb-6 text-left border border-white/10 cursor-pointer hover:border-[#F59E0B]/50 transition"
          >
            <p className="text-sm text-secondary mb-1 flex justify-between">
              Your DID
              <span className="text-xs">{copied ? '✅ Copied!' : '📋 Click to copy'}</span>
            </p>
            <p className="font-mono text-xs break-all text-primary">{profile.did}</p>
          </div>

          <div className="bg-[#F59E0B]/10 border border-[#F59E0B]/30 p-4 mb-6 text-left">
            <p className="text-sm font-semibold text-[#F59E0B] mb-2">
              🔐 Back Up Your Keys Now
            </p>
            <p className="text-xs text-primary mb-3">
              Your private key is only stored in this browser. If you clear your data or lose this device,
              <strong> you will permanently lose access to your identity.</strong>
            </p>
            <button
              onClick={downloadKeys}
              className="w-full px-4 py-2 bg-[#F59E0B] text-black hover:bg-[#D97706] transition text-sm font-medium"
            >
              ⬇️ Download Backup Keys
            </button>
          </div>

          {redirectUrl ? (
            <a
              href={redirectUrl}
              className="block w-full px-6 py-3 bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-semibold text-center"
            >
              Continue →
            </a>
          ) : (
            <button
              onClick={() => router.push(`/profile/${profile.handle || profile.did}`)}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-semibold"
            >
              View Your Profile →
            </button>
          )}
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-[#0a0a0a] border border-white/10 p-8">
          <div className="text-6xl mb-4">😕</div>
          <h1 className="text-2xl font-bold mb-2 text-primary font-mono">Something went wrong</h1>
          <p className="text-error mb-6">{error}</p>
          <button
            onClick={() => setStep('form')}
            className="px-6 py-3 bg-surface-elevated text-primary hover:bg-surface-elevated transition"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (step === 'creating') {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-[#0a0a0a] border border-white/10 p-8">
          <div className="text-6xl mb-4 animate-pulse">🔐</div>
          <h1 className="text-2xl font-bold mb-2 text-primary font-mono">Creating your identity...</h1>
          <p className="text-secondary">
            Generating keypair and registering on the network.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      {showBanner && (
        <div className="bg-[#F59E0B]/10 border border-[#F59E0B]/30 p-4 mb-4 flex items-center justify-between">
          <div className="flex-1">
            <p className="text-sm text-[#F59E0B] font-medium">
              Already registered as {loggedInHandle ? `@${loggedInHandle}` : 'a user'}
            </p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => router.push(`/profile/${loggedInHandle || did}`)}
                className="text-xs text-[#F59E0B] hover:underline"
              >
                Go to profile
              </button>
              <span className="text-muted">•</span>
              <button
                onClick={() => setShowBanner(false)}
                className="text-xs text-secondary hover:underline"
              >
                Register new identity
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-[#0a0a0a] border border-white/10 p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-primary font-mono">Join Imajin</h1>
        <p className="text-secondary text-center mb-6">
          Create your sovereign identity. No passwords, no email.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-primary">Display Name *</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              required
              className="w-full px-4 py-2 border border-white/10 bg-surface-base text-primary focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-primary">Handle</label>
            <div className="flex items-center">
              <span className="text-secondary mr-1">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(normalizeHandleInput(e.target.value))}
                placeholder="yourhandle"
                pattern="[a-z0-9\-]{3,30}"
                className="flex-1 px-4 py-2 border border-white/10 bg-surface-base text-primary focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
              />
            </div>
            {handleStatus !== 'idle' && handle.length >= 3 && (
              <p className={`text-xs mt-1 flex items-center gap-1 ${
                handleStatus === 'checking' ? 'text-secondary' :
                handleStatus === 'available' ? 'text-success' :
                'text-error'
              }`}>
                {handleStatus === 'checking' && '⏳ Checking...'}
                {handleStatus === 'available' && '✅ Available'}
                {handleStatus === 'taken' && '❌ Taken'}
                {handleStatus === 'invalid' && `❌ ${handleMessage}`}
                {(handleStatus === 'available' || handleStatus === 'taken') && ` - ${handleMessage}`}
              </p>
            )}
            {(handleStatus === 'idle' || handle.length < 3) && (
              <p className="text-xs text-secondary mt-1">3-30 chars, lowercase, alphanumeric + hyphens</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-primary">Bio (optional)</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell us about yourself..."
              rows={3}
              maxLength={500}
              className="w-full px-4 py-2 border border-white/10 bg-surface-base text-primary focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent resize-none"
            />
          </div>

          {/* Avatar Selection */}
          <div>
            {avatarMode === 'image' ? (
              <ImageUpload
                did={tempDid}
                currentAvatar={avatar}
                onUploadComplete={(url) => setAvatar(url)}
                onToggleToEmoji={() => {
                  setAvatarMode('emoji');
                  setAvatar('👤');
                }}
                showEmojiToggle={true}
              />
            ) : (
              <div>
                <label className="block text-sm font-medium mb-1 text-primary">Avatar (emoji)</label>
                <input
                  type="text"
                  value={avatar}
                  onChange={(e) => setAvatar(e.target.value)}
                  placeholder="👤"
                  className="w-full px-4 py-2 border border-white/10 bg-surface-base text-primary focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setAvatarMode('image')}
                  className="mt-2 text-sm text-[#F59E0B] hover:underline"
                >
                  Or upload an image instead →
                </button>
              </div>
            )}
          </div>

          <button
            type="submit"
            className="w-full px-6 py-3 bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-semibold"
          >
            Create Identity
          </button>
        </form>

        <p className="text-xs text-secondary text-center mt-6">
          By creating an identity, you generate a cryptographic keypair.
          <br />
          No data leaves your device until you submit.
        </p>
      </div>
    </div>
  );
}
