'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Link {
  id: string;
  title: string;
  url: string;
  icon?: string;
  thumbnail?: string;
  position: number;
  isActive: boolean;
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

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<LinkPage | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editingLink, setEditingLink] = useState<Link | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    handle: '',
    title: '',
    bio: '',
    avatar: '',
  });

  const [linkFormData, setLinkFormData] = useState({
    title: '',
    url: '',
    icon: '',
  });

  useEffect(() => {
    fetchPage();
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
        window.location.href = '/';
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
        const newPage = await res.json();
        // Fetch the full page with links
        const fullPageRes = await fetch('/api/pages/mine', {
          credentials: 'include',
        });
        if (fullPageRes.ok) {
          const data = await fullPageRes.json();
          setPage(data.id ? data : null);
        }
      }
    } catch (error) {
      console.error('Failed to auto-create page:', error);
      // Show create form if auto-create fails
      setPage(null);
    }
  };

  const createPage = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        await fetchPage();
        setShowCreateForm(false);
        setFormData({ handle: '', title: '', bio: '', avatar: '' });
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to create page');
      }
    } catch (error) {
      console.error('Failed to create page:', error);
      alert('Failed to create page');
    }
  };

  const updatePage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!page) return;

    try {
      const res = await fetch(`/api/pages/${page.handle}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: formData.title,
          bio: formData.bio,
          avatar: formData.avatar,
        }),
      });

      if (res.ok) {
        await fetchPage();
        setShowEditForm(false);
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to update page');
      }
    } catch (error) {
      console.error('Failed to update page:', error);
      alert('Failed to update page');
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
          links: [linkFormData],
        }),
      });

      if (res.ok) {
        await fetchPage();
        setShowLinkForm(false);
        setLinkFormData({ title: '', url: '', icon: '' });
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to add link');
      }
    } catch (error) {
      console.error('Failed to add link:', error);
      alert('Failed to add link');
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
        }),
      });

      if (res.ok) {
        await fetchPage();
        setEditingLink(null);
        setLinkFormData({ title: '', url: '', icon: '' });
      } else {
        const error = await res.json();
        alert(error.error || 'Failed to update link');
      }
    } catch (error) {
      console.error('Failed to update link:', error);
      alert('Failed to update link');
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
        alert(error.error || 'Failed to delete link');
      }
    } catch (error) {
      console.error('Failed to delete link:', error);
      alert('Failed to delete link');
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
      alert('Failed to reorder links');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (!page && !showCreateForm) {
    return (
      <div className="min-h-screen py-12 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-6xl mb-4">🔗</div>
          <h1 className="text-3xl font-bold mb-4">Create Your Links Page</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-8">
            Set up your sovereign link-in-bio page on Imajin
          </p>
          <button
            onClick={() => setShowCreateForm(true)}
            className="px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
          >
            Create Links Page
          </button>
        </div>
      </div>
    );
  }

  if (showCreateForm && !page) {
    return (
      <div className="min-h-screen py-12 px-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-2xl font-bold mb-6">Create Links Page</h1>
          <form onSubmit={createPage} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Handle *</label>
              <input
                type="text"
                value={formData.handle}
                onChange={(e) => setFormData({ ...formData, handle: e.target.value })}
                placeholder="yourhandle"
                required
                pattern="[a-z0-9_]{3,30}"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
              />
              <p className="text-xs text-gray-500 mt-1">3-30 characters, lowercase letters, numbers, and underscores only</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Title *</label>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Your Name"
                required
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Bio</label>
              <textarea
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                placeholder="A short description"
                rows={3}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Avatar</label>
              <input
                type="text"
                value={formData.avatar}
                onChange={(e) => setFormData({ ...formData, avatar: e.target.value })}
                placeholder="URL or emoji (e.g., 🔗)"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
              />
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                className="flex-1 px-6 py-3 bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600 transition"
              >
                Create Page
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="px-6 py-3 border border-gray-300 dark:border-gray-700 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  if (!page) return null;

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Your Links Page</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              <a
                href={`/${page.handle}`}
                target="_blank"
                className="text-orange-500 hover:underline"
              >
                /{page.handle}
              </a>
            </p>
          </div>
          <button
            onClick={() => {
              setFormData({
                handle: page.handle,
                title: page.title,
                bio: page.bio || '',
                avatar: page.avatar || '',
              });
              setShowEditForm(true);
            }}
            className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition"
          >
            Edit Page
          </button>
        </div>

        {showEditForm && (
          <div className="mb-8 p-6 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h2 className="text-xl font-semibold mb-4">Edit Page</h2>
            <form onSubmit={updatePage} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Title *</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  required
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Bio</label>
                <textarea
                  value={formData.bio}
                  onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Avatar</label>
                <input
                  type="text"
                  value={formData.avatar}
                  onChange={(e) => setFormData({ ...formData, avatar: e.target.value })}
                  placeholder="URL or emoji"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
                />
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

        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Links ({page.links.length})</h2>
          <button
            onClick={() => setShowLinkForm(true)}
            className="px-4 py-2 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600 transition"
          >
            Add Link
          </button>
        </div>

        {(showLinkForm || editingLink) && (
          <div className="mb-6 p-6 bg-gray-50 dark:bg-gray-900 rounded-lg">
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
                    setLinkFormData({ title: '', url: '', icon: '' });
                  }}
                  className="px-6 py-2 border border-gray-300 dark:border-gray-700 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="space-y-3">
          {page.links.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <p>No links yet. Add your first link above!</p>
            </div>
          ) : (
            page.links.map((link, index) => (
              <div
                key={link.id}
                className="p-4 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 flex items-center justify-between"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {link.icon && <span>{link.icon}</span>}
                    <span className="font-semibold">{link.title}</span>
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
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
                    className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveLink(link.id, 'down')}
                    disabled={index === page.links.length - 1}
                    className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded disabled:opacity-30"
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
