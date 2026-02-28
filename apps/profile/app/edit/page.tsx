'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useIdentity } from '../context/IdentityContext';
import { ImageUpload } from '../components/ImageUpload';

interface Profile {
  did: string;
  handle?: string;
  displayName: string;
  displayType: string;
  bio?: string;
  avatar?: string;
  email?: string;
  phone?: string;
}

type AvatarMode = 'emoji' | 'image';

export default function EditProfilePage() {
  const router = useRouter();
  const { did, isLoggedIn, refreshProfile } = useIdentity();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Form state
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [avatarMode, setAvatarMode] = useState<AvatarMode>('emoji');

  useEffect(() => {
    if (!isLoggedIn || !did) {
      router.push('/login');
      return;
    }

    loadProfile();
  }, [isLoggedIn, did]);

  async function loadProfile() {
    if (!did) return;

    try {
      const response = await fetch(`/api/profile/${did}`);
      if (!response.ok) {
        throw new Error('Failed to load profile');
      }

      const profile: Profile = await response.json();
      setDisplayName(profile.displayName || '');
      setBio(profile.bio || '');
      setAvatar(profile.avatar || '');
      setHandle(profile.handle || '');
      setEmail(profile.email || '');
      setPhone(profile.phone || '');

      // Detect avatar mode based on current avatar
      if (profile.avatar && (profile.avatar.startsWith('http') || profile.avatar.startsWith('/'))) {
        setAvatarMode('image');
      } else {
        setAvatarMode('emoji');
      }
    } catch (err: any) {
      console.error('Failed to load profile:', err);
      setError('Failed to load profile');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess(false);
    setSaving(true);

    try {
      // For now, we'll just verify DID matches localStorage
      // Proper signature verification will be added later
      const response = await fetch(`/api/profile/${did}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          // TODO: Add proper signed request headers
        },
        body: JSON.stringify({
          displayName,
          bio: bio || null,
          avatar: avatar || null,
          email: email || null,
          phone: phone || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Update failed');
      }

      setSuccess(true);
      await refreshProfile();

      // Redirect to profile after 1 second
      setTimeout(() => {
        router.push(`/${handle || did}`);
      }, 1000);
    } catch (err: any) {
      console.error('Update failed:', err);
      setError(err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-md mx-auto text-center">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-[#F59E0B] mb-4"></div>
          <p className="text-gray-400">Loading profile...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-white">Edit Profile</h1>
        <p className="text-gray-400 text-center mb-6">
          Update your public profile information
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Handle (read-only) */}
          {handle && (
            <div>
              <label className="block text-sm font-medium mb-1 text-gray-300">Handle</label>
              <div className="flex items-center px-4 py-2 border border-gray-700 rounded-lg bg-gray-900/50 text-gray-500">
                <span className="mr-1">@</span>
                <span>{handle}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Handle cannot be changed after registration</p>
            </div>
          )}

          {/* Display Name */}
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Display Name *</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              required
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
          </div>

          {/* Bio */}
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell us about yourself..."
              rows={3}
              maxLength={500}
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent resize-none"
            />
            <p className="text-xs text-gray-500 mt-1">{bio.length}/500 characters</p>
          </div>

          {/* Contact Info */}
          <div className="pt-2 border-t border-gray-800">
            <p className="text-xs text-gray-500 mb-3">🔒 Contact info is only visible to your connections</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-300">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-300">Phone</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 123-4567"
                  className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Avatar */}
          <div>
            {avatarMode === 'image' ? (
              <ImageUpload
                did={did}
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
                <label className="block text-sm font-medium mb-1 text-gray-300">Avatar (emoji)</label>
                <input
                  type="text"
                  value={avatar}
                  onChange={(e) => setAvatar(e.target.value)}
                  placeholder="👤"
                  className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
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

          {/* Error/Success messages */}
          {error && (
            <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-900/20 border border-green-800 rounded-lg">
              <p className="text-sm text-green-400">Profile updated successfully! Redirecting...</p>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => router.push(`/${handle || did}`)}
              className="flex-1 px-6 py-3 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !displayName.trim()}
              className="flex-1 px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>

        {/* Key Backup */}
        <div className="mt-6 pt-4 border-t border-gray-800">
          <div className="bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg p-4">
            <p className="text-sm font-semibold text-[#F59E0B] mb-2">
              🔐 Identity Backup
            </p>
            <p className="text-xs text-gray-300 mb-3">
              Your private key is only stored in this browser. Download a backup to log in from other devices or recover your account.
            </p>
            <button
              type="button"
              onClick={() => {
                const keypair = localStorage.getItem('imajin_keypair');
                const storedDid = localStorage.getItem('imajin_did');
                if (!keypair || !storedDid) {
                  setError('No keys found in this browser. You may have logged in via key import — your backup file IS your key.');
                  return;
                }
                const backup = {
                  did: storedDid,
                  keypair: JSON.parse(keypair),
                  exportedAt: new Date().toISOString(),
                  warning: 'Keep this file safe. Anyone with access can control your identity.',
                };
                const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `imajin-keys-${storedDid.slice(-8)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="w-full px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition text-sm font-medium"
            >
              ⬇️ Download Backup Keys
            </button>
          </div>
        </div>

        {/* DID display */}
        <div className="mt-4 pt-4 border-t border-gray-800">
          <p className="text-xs text-gray-500 text-center font-mono break-all">
            {did}
          </p>
        </div>
      </div>
    </div>
  );
}
