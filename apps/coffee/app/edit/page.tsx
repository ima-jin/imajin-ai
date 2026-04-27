'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { MarkdownContent } from '@imajin/ui';
import { apiFetch } from '@imajin/config';

const MarkdownEditor = dynamic(
  () => import('@imajin/ui').then((m) => ({ default: m.MarkdownEditor })),
  { ssr: false }
);

interface FundDirection {
  id: string;
  label: string;
  description: string;
}

interface CoffeePage {
  id: string;
  handle: string;
  title: string;
  bio?: string;
  avatar?: string;
  theme?: {
    primaryColor?: string;
    backgroundColor?: string;
  };
  presets?: number[];
  fundDirections?: FundDirection[];
  allowCustomAmount?: boolean;
  allowMessages?: boolean;
  isPublic?: boolean;
  thankYouContent?: string;
}

export default function EditPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [existingPage, setExistingPage] = useState<CoffeePage | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Form fields
  const [handle, setHandle] = useState('');
  const [title, setTitle] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('☕');
  const [primaryColor, setPrimaryColor] = useState('#f97316');
  const [backgroundColor, setBackgroundColor] = useState('#fffbeb');
  const [presets, setPresets] = useState('500,1000,2000');
  const [allowCustomAmount, setAllowCustomAmount] = useState(true);
  const [allowMessages, setAllowMessages] = useState(true);
  const [isPublic, setIsPublic] = useState(true);
  const [fundDirections, setFundDirections] = useState<FundDirection[]>([]);
  const [thankYouContent, setThankYouContent] = useState('');
  const [showThankYouPreview, setShowThankYouPreview] = useState(false);

  const commonEmojis = ['☕', '💰', '🎨', '💻', '📚', '🎵', '🎮', '🏋️', '🍕', '🚀', '🌟', '💡', '🔥', '❤️', '👋', '🎯'];

  useEffect(() => {
    async function loadPage() {
      try {
        const res = await apiFetch('/api/pages/mine', {
          credentials: 'include',
        });

        if (res.ok) {
          const page = await res.json();
          setExistingPage(page);
          setHandle(page.handle);
          setTitle(page.title);
          setBio(page.bio || '');
          setAvatar(page.avatar || '☕');
          setPrimaryColor(page.theme?.primaryColor || '#f97316');
          setBackgroundColor(page.theme?.backgroundColor || '#fffbeb');
          setPresets((page.presets || [500, 1000, 2000]).join(','));
          setAllowCustomAmount(page.allowCustomAmount !== false);
          setAllowMessages(page.allowMessages !== false);
          setIsPublic(page.isPublic !== false);
          setFundDirections(page.fundDirections || []);
          setThankYouContent(page.thankYouContent || '');
        } else if (res.status !== 404) {
          // 404 means no page exists yet, which is fine
          setError('Failed to load coffee page');
        }
      } catch (err) {
        console.error('Failed to load page:', err);
        setError('Failed to load coffee page');
      } finally {
        setIsLoading(false);
      }
    }

    loadPage();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSaving(true);

    try {
      // Parse presets
      const presetArray = presets
        .split(',')
        .map(p => parseInt(p.trim()))
        .filter(p => !isNaN(p) && p > 0);

      if (presetArray.length === 0) {
        setError('Please add at least one preset amount');
        setIsSaving(false);
        return;
      }

      const payload = {
        handle,
        title,
        bio,
        avatar,
        theme: {
          primaryColor,
          backgroundColor,
        },
        paymentMethods: {
          stripe: {
            // This would be configured separately, for now just placeholder
            enabled: true,
          },
        },
        presets: presetArray,
        fundDirections: fundDirections.filter(d => d.label.trim()),
        thankYouContent: thankYouContent || null,
        allowCustomAmount,
        allowMessages,
        isPublic,
      };

      let res;
      if (existingPage) {
        // Update existing page
        res = await apiFetch(`/api/pages/${existingPage.handle}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
      } else {
        // Create new page
        res = await apiFetch('/api/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save page');
      }

      const savedPage = await res.json();
      router.push(`/${savedPage.handle}`);
    } catch (err: any) {
      setError(err.message);
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-surface-base py-8 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-4xl mb-4">☕</div>
          <p className="text-muted dark:text-secondary">Loading...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-surface-base py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">
            {existingPage ? 'Edit Your Coffee Page' : 'Create Your Coffee Page'}
          </h1>
          <p className="text-muted dark:text-secondary">
            Set up your sovereign support page and start receiving tips
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Handle */}
          <div className="bg-white dark:bg-surface-elevated p-6">
            <label className="block text-sm font-medium mb-2">
              Handle *
            </label>
            <div className="flex items-center gap-2">
              <span className="text-secondary">coffee.imajin.ai/</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                disabled={!!existingPage}
                required
                className="flex-1 px-4 py-2 border border-white/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-white dark:bg-surface-elevated disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="yourname"
              />
            </div>
            {existingPage && (
              <p className="text-xs text-secondary mt-1">Handle cannot be changed</p>
            )}
          </div>

          {/* Title & Bio */}
          <div className="bg-white dark:bg-surface-elevated p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                Title *
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                className="w-full px-4 py-2 border border-white/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-white dark:bg-surface-elevated"
                placeholder="Buy me a coffee"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Bio
              </label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                className="w-full px-4 py-2 border border-white/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-white dark:bg-surface-elevated"
                placeholder="Tell supporters about yourself..."
              />
            </div>
          </div>

          {/* Avatar */}
          <div className="bg-white dark:bg-surface-elevated p-6">
            <label className="block text-sm font-medium mb-2">
              Avatar
            </label>
            <div className="flex items-center gap-4">
              <div className="text-6xl">{avatar}</div>
              <div className="flex-1">
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  className="px-4 py-2 bg-surface-elevated dark:bg-surface-elevated:bg-surface-elevated dark:hover:bg-surface-elevated transition"
                >
                  Pick Emoji
                </button>
                {showEmojiPicker && (
                  <div className="mt-2 grid grid-cols-8 gap-2 p-3 bg-surface-elevated dark:bg-surface-elevated">
                    {commonEmojis.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          setAvatar(emoji);
                          setShowEmojiPicker(false);
                        }}
                        className="text-3xl:scale-125 transition"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Theme Colors */}
          <div className="bg-white dark:bg-surface-elevated p-6 space-y-4">
            <h3 className="font-medium">Theme</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm mb-2">Primary Color</label>
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="w-full h-12 border border-white/10 dark:border-white/10 cursor-pointer"
                />
              </div>
              <div>
                <label className="block text-sm mb-2">Background Color</label>
                <input
                  type="color"
                  value={backgroundColor}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  className="w-full h-12 border border-white/10 dark:border-white/10 cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Presets */}
          <div className="bg-white dark:bg-surface-elevated p-6">
            <label className="block text-sm font-medium mb-2">
              Preset Amounts (cents, comma-separated) *
            </label>
            <input
              type="text"
              value={presets}
              onChange={(e) => setPresets(e.target.value)}
              required
              className="w-full px-4 py-2 border border-white/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-white dark:bg-surface-elevated"
              placeholder="500,1000,2000"
            />
            <p className="text-xs text-secondary mt-1">
              Example: 500,1000,2000 = $5, $10, $20
            </p>
          </div>

          {/* Fund Directions */}
          <div className="bg-white dark:bg-surface-elevated p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Fund Directions</h3>
                <p className="text-xs text-secondary mt-1">
                  Let supporters choose where their money goes. Trust graph verifiable.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFundDirections([...fundDirections, { id: `fd_${Date.now()}`, label: '', description: '' }])}
                className="px-3 py-1.5 bg-imajin-orange/10 dark:bg-imajin-orange/10 text-imajin-orange dark:text-imajin-orange text-sm font-medium:bg-orange-200 dark:hover:bg-imajin-orange/10 transition"
              >
                + Add Direction
              </button>
            </div>
            {fundDirections.length === 0 && (
              <p className="text-sm text-secondary italic">
                No fund directions yet. Add some to let supporters choose — e.g. "Living expenses", "Platform development", "Medical costs"
              </p>
            )}
            {fundDirections.map((fd, idx) => (
              <div key={fd.id} className="flex gap-3 items-start bg-surface-elevated dark:bg-surface-elevated/50 p-3">
                <div className="flex-1 space-y-2">
                  <input
                    type="text"
                    value={fd.label}
                    onChange={(e) => {
                      const updated = [...fundDirections];
                      updated[idx] = { ...fd, label: e.target.value };
                      setFundDirections(updated);
                    }}
                    className="w-full px-3 py-1.5 border border-white/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-white dark:bg-surface-elevated text-sm"
                    placeholder="Label — e.g. Living expenses"
                  />
                  <input
                    type="text"
                    value={fd.description}
                    onChange={(e) => {
                      const updated = [...fundDirections];
                      updated[idx] = { ...fd, description: e.target.value };
                      setFundDirections(updated);
                    }}
                    className="w-full px-3 py-1.5 border border-white/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-imajin-purple bg-white dark:bg-surface-elevated text-sm"
                    placeholder="Description — e.g. Help me keep the lights on"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setFundDirections(fundDirections.filter((_, i) => i !== idx))}
                  className="text-error:text-error text-sm p-1"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Thank You Page */}
          <div className="bg-white dark:bg-surface-elevated p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Thank You Page</h3>
                <p className="text-xs text-secondary mt-1">
                  Custom message shown after someone tips you. Supports markdown.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowThankYouPreview(false)}
                  className={`px-3 py-1.5 text-sm font-medium transition ${ !showThankYouPreview ? 'bg-imajin-orange/10 dark:bg-imajin-orange/10 text-imajin-orange dark:text-imajin-orange' : 'text-secondary:text-muted dark:hover:text-primary' }`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setShowThankYouPreview(true)}
                  className={`px-3 py-1.5 text-sm font-medium transition ${ showThankYouPreview ? 'bg-imajin-orange/10 dark:bg-imajin-orange/10 text-imajin-orange dark:text-imajin-orange' : 'text-secondary:text-muted dark:hover:text-primary' }`}
                >
                  Preview
                </button>
              </div>
            </div>
            {showThankYouPreview ? (
              <div className="min-h-[120px] p-4 bg-surface-elevated dark:bg-surface-elevated/50">
                {thankYouContent ? (
                  <MarkdownContent content={thankYouContent} />
                ) : (
                  <p className="text-secondary italic text-sm">
                    No custom content — the default thank-you message will be shown.
                  </p>
                )}
              </div>
            ) : (
              <MarkdownEditor
                value={thankYouContent}
                onChange={setThankYouContent}
                placeholder="Write a personal thank-you message for your supporters..."
              />
            )}
          </div>

          {/* Options */}
          <div className="bg-white dark:bg-surface-elevated p-6 space-y-3">
            <h3 className="font-medium mb-4">Options</h3>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={allowCustomAmount}
                onChange={(e) => setAllowCustomAmount(e.target.checked)}
                className="w-5 h-5 border-white/10 text-imajin-orange focus:ring-imajin-purple"
              />
              <span className="text-sm">Allow custom amounts</span>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={allowMessages}
                onChange={(e) => setAllowMessages(e.target.checked)}
                className="w-5 h-5 border-white/10 text-imajin-orange focus:ring-imajin-purple"
              />
              <span className="text-sm">Allow supporter messages</span>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="w-5 h-5 border-white/10 text-imajin-orange focus:ring-imajin-purple"
              />
              <span className="text-sm">Make page public</span>
            </label>
          </div>

          {/* Error */}
          {error && (
            <div className="bg-error/10 dark:bg-error/10 border border-error/20 dark:border-error/20 p-4 text-error dark:text-error">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 py-3 bg-imajin-orange hover:brightness-110 text-primary font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? 'Saving...' : existingPage ? 'Update Page' : 'Create Page'}
            </button>
            {existingPage && (
              <button
                type="button"
                onClick={() => router.push(`/${existingPage.handle}`)}
                className="px-6 py-3 bg-surface-elevated dark:bg-surface-elevated:bg-surface-elevated dark:hover:bg-surface-elevated text-gray-800 dark:text-primary font-semibold transition"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}
