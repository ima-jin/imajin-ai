'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@imajin/ui';

interface Link {
  id: string;
  title: string;
  url: string;
  icon?: string;
  thumbnail?: string;
  position: number;
  isActive: boolean;
  visibility: string;
  clicks: number;
}

interface LinkPage {
  id: string;
  did: string;
  handle: string;
  title: string;
  bio?: string;
  avatar?: string;
  theme: any;
  isPublic: boolean;
  links: Link[];
}

const THEME_PRESETS = {
  dark: {
    name: 'Dark',
    backgroundColor: '#1a1a1a',
    textColor: '#ffffff',
    buttonColor: '#f97316',
    buttonTextColor: '#000000',
    buttonStyle: 'pill',
  },
  light: {
    name: 'Light',
    backgroundColor: '#ffffff',
    textColor: '#1a1a1a',
    buttonColor: '#007bff',
    buttonTextColor: '#ffffff',
    buttonStyle: 'pill',
  },
  midnight: {
    name: 'Midnight',
    backgroundColor: '#0d1117',
    textColor: '#c9d1d9',
    buttonColor: '#238636',
    buttonTextColor: '#ffffff',
    buttonStyle: 'rounded',
  },
  sunset: {
    name: 'Sunset',
    backgroundColor: '#fef3c7',
    textColor: '#78350f',
    buttonColor: '#f59e0b',
    buttonTextColor: '#ffffff',
    buttonStyle: 'rounded',
  },
  ocean: {
    name: 'Ocean',
    backgroundColor: '#0f172a',
    textColor: '#e2e8f0',
    buttonColor: '#06b6d4',
    buttonTextColor: '#ffffff',
    buttonStyle: 'pill',
  },
};

export default function EditPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<LinkPage | null>(null);
  const [autoCreateError, setAutoCreateError] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editingLink, setEditingLink] = useState<Link | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    theme: 'dark',
  });

  const [linkFormData, setLinkFormData] = useState({
    title: '',
    url: '',
    icon: '',
    visibility: 'public',
    isActive: true,
  });

  useEffect(() => {
    fetchPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPage = async () => {
    try {
      const res = await fetch('/api/pages/mine', {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        if (data.id) {
          setPage(data);
        } else {
          // Auto-create page on first visit
          await autoCreatePage();
        }
      } else if (res.status === 401) {
        window.location.href = 'https://auth.imajin.ai';
      }
    } catch (error) {
      console.error('Failed to fetch page:', error);
    } finally {
      setLoading(false);
    }
  };

  const autoCreatePage = async () => {
    try {
      const res = await fetch('/api/pages/auto-create', {
        method: 'POST',
        credentials: 'include',
      });

      if (res.ok) {
        // Fetch the full page with links
        const fullPageRes = await fetch('/api/pages/mine', {
          credentials: 'include',
        });
        if (fullPageRes.ok) {
          const data = await fullPageRes.json();
          setPage(data.id ? data : null);
        }
      } else {
        setAutoCreateError(true);
      }
    } catch (error) {
      console.error('Failed to auto-create page:', error);
      setAutoCreateError(true);
    }
  };

  const updatePage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!page) return;

    try {
      const theme = THEME_PRESETS[formData.theme as keyof typeof THEME_PRESETS];
      const res = await fetch(`/api/pages/${page.handle}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ theme }),
      });

      if (res.ok) {
        await fetchPage();
        setShowEditForm(false);
      } else {
        const error = await res.json();
        toast.error(error.error || 'Failed to update page');
      }
    } catch (error) {
      console.error('Failed to update page:', error);
      toast.error('Failed to update page');
    }
  };

  const addLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!page) return;

    try {
      const res = await fetch(`/api/pages/${page.handle}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          links: [{
            title: linkFormData.title,
            url: linkFormData.url,
            icon: linkFormData.icon,
            visibility: linkFormData.visibility,
            isActive: linkFormData.isActive,
          }],
        }),
      });

      if (res.ok) {
        await fetchPage();
        setShowLinkForm(false);
        setLinkFormData({ title: '', url: '', icon: '', visibility: 'public', isActive: true });
      } else {
        const error = await res.json();
        toast.error(error.error || 'Failed to add link');
      }
    } catch (error) {
      console.error('Failed to add link:', error);
      toast.error('Failed to add link');
    }
  };

  const updateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLink) return;

    try {
      const res = await fetch(`/api/links/${editingLink.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: linkFormData.title,
          url: linkFormData.url,
          icon: linkFormData.icon,
          visibility: linkFormData.visibility,
          isActive: linkFormData.isActive,
        }),
      });

      if (res.ok) {
        await fetchPage();
        setEditingLink(null);
        setLinkFormData({ title: '', url: '', icon: '', visibility: 'public', isActive: true });
      } else {
        const error = await res.json();
        toast.error(error.error || 'Failed to update link');
      }
    } catch (error) {
      console.error('Failed to update link:', error);
      toast.error('Failed to update link');
    }
  };

  const deleteLink = async (linkId: string) => {
    if (!confirm('Delete this link?')) return;

    try {
      const res = await fetch(`/api/links/${linkId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        await fetchPage();
      } else {
        const error = await res.json();
        toast.error(error.error || 'Failed to delete link');
      }
    } catch (error) {
      console.error('Failed to delete link:', error);
      toast.error('Failed to delete link');
    }
  };

  const moveLink = async (linkId: string, direction: 'up' | 'down') => {
    if (!page) return;

    const currentIndex = page.links.findIndex(l => l.id === linkId);
    if (currentIndex === -1) return;
    if (direction === 'up' && currentIndex === 0) return;
    if (direction === 'down' && currentIndex === page.links.length - 1) return;

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    const targetLink = page.links[newIndex];

    try {
      await Promise.all([
        fetch(`/api/links/${linkId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ position: targetLink.position }),
        }),
        fetch(`/api/links/${targetLink.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ position: page.links[currentIndex].position }),
        }),
      ]);

      await fetchPage();
    } catch (error) {
      console.error('Failed to reorder links:', error);
      toast.error('Failed to reorder links');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (!page) {
    if (autoCreateError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
          <div className="text-center">
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              Failed to set up your links page. Please try refreshing.
            </p>
            <button
              onClick={() => { setAutoCreateError(false); setLoading(true); fetchPage(); }}
              className="px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="min-h-screen py-12 px-4 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">My Links</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              <a
                href={`/${page.handle}`}
                target="_blank"
                className="text-orange-500 hover:underline"
              >
                links.imajin.ai/{page.handle}
              </a>
            </p>
          </div>
          <div className="flex gap-3">
            <a
              href="/dashboard"
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              Go to Stats
            </a>
            <button
              onClick={() => {
                setFormData({ theme: 'dark' });
                setShowEditForm(true);
              }}
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              Edit Theme
            </button>
          </div>
        </div>

        {/* Edit Page Form */}
        {showEditForm && (
          <div className="mb-8 p-6 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4">Edit Page</h2>
            <form onSubmit={updatePage} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Theme</label>
                <select
                  value={formData.theme}
                  onChange={(e) => setFormData({ ...formData, theme: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                >
                  {Object.entries(THEME_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>{preset.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3">
                <button
                  type="submit"
                  className="px-6 py-2 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
                >
                  Save Changes
                </button>
                <button
                  type="button"
                  onClick={() => setShowEditForm(false)}
                  className="px-6 py-2 border border-gray-300 dark:border-gray-700 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Links Section */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Links ({page.links.length})</h2>
          <button
            onClick={() => setShowLinkForm(true)}
            className="px-4 py-2 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600 transition"
          >
            Add Link
          </button>
        </div>

        {/* Link Form */}
        {(showLinkForm || editingLink) && (
          <div className="mb-6 p-6 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold mb-4">
              {editingLink ? 'Edit Link' : 'Add New Link'}
            </h3>
            <form onSubmit={editingLink ? updateLink : addLink} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Title *</label>
                <input
                  type="text"
                  value={linkFormData.title}
                  onChange={(e) => setLinkFormData({ ...linkFormData, title: e.target.value })}
                  placeholder="Link title"
                  required
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">URL *</label>
                <input
                  type="url"
                  value={linkFormData.url}
                  onChange={(e) => setLinkFormData({ ...linkFormData, url: e.target.value })}
                  placeholder="https://example.com"
                  required
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Icon (emoji)</label>
                <input
                  type="text"
                  value={linkFormData.icon}
                  onChange={(e) => setLinkFormData({ ...linkFormData, icon: e.target.value })}
                  placeholder="🔗"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Visibility</label>
                <select
                  value={linkFormData.visibility}
                  onChange={(e) => setLinkFormData({ ...linkFormData, visibility: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                >
                  <option value="public">Public (visible to everyone)</option>
                  <option value="authenticated">Authenticated only (logged in users)</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={linkFormData.isActive}
                  onChange={(e) => setLinkFormData({ ...linkFormData, isActive: e.target.checked })}
                  className="w-4 h-4"
                />
                <label htmlFor="isActive" className="text-sm font-medium">
                  Active (show on page)
                </label>
              </div>

              <div className="flex gap-3">
                <button
                  type="submit"
                  className="px-6 py-2 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
                >
                  {editingLink ? 'Save Changes' : 'Add Link'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLinkForm(false);
                    setEditingLink(null);
                    setLinkFormData({ title: '', url: '', icon: '', visibility: 'public', isActive: true });
                  }}
                  className="px-6 py-2 border border-gray-300 dark:border-gray-700 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Links List */}
        <div className="space-y-3">
          {page.links.length === 0 ? (
            <div className="text-center py-12 text-gray-500 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <p>No links yet. Add your first link above!</p>
            </div>
          ) : (
            page.links.map((link, index) => (
              <div
                key={link.id}
                className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 flex items-center justify-between"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {link.icon && <span>{link.icon}</span>}
                    <span className="font-semibold">{link.title}</span>
                    {!link.isActive && (
                      <span className="text-xs px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded">Inactive</span>
                    )}
                    {link.visibility === 'authenticated' && (
                      <span className="text-xs px-2 py-1 bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 rounded">
                        🔒 Auth only
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-1 truncate">
                    {link.url}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {link.clicks} clicks
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => moveLink(link.id, 'up')}
                    disabled={index === 0}
                    className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveLink(link.id, 'down')}
                    disabled={index === page.links.length - 1}
                    className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => {
                      setEditingLink(link);
                      setLinkFormData({
                        title: link.title,
                        url: link.url,
                        icon: link.icon || '',
                        visibility: link.visibility || 'public',
                        isActive: link.isActive,
                      });
                    }}
                    className="px-3 py-1 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteLink(link.id)}
                    className="px-3 py-1 border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
