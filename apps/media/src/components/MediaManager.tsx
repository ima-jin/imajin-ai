"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { FolderTree } from "./FolderTree";
import { AssetGrid } from "./AssetGrid";
import { AssetDetail } from "./AssetDetail";
import type { Asset, Folder } from "@/src/db/schema";
import type { Identity } from "@/src/lib/auth";

interface FolderWithCount extends Folder {
  assetCount?: number;
}

interface MediaManagerProps {
  session: Identity;
}

type SortKey = "created" | "name" | "size";

function clientSort(assets: Asset[], sort: SortKey, order: "asc" | "desc"): Asset[] {
  const sorted = [...assets].sort((a, b) => {
    if (sort === "name") return a.filename.localeCompare(b.filename);
    if (sort === "size") return a.size - b.size;
    // created
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });
  return order === "desc" ? sorted.reverse() : sorted;
}

export function MediaManager({ session: _session }: MediaManagerProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [allAssets, setAllAssets] = useState<Asset[]>([]);
  const [folders, setFolders] = useState<FolderWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("created");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const loadFolders = useCallback(async () => {
    const res = await fetch("/api/folders", { credentials: "include" });
    if (res.ok) {
      const data = await res.json() as { folders?: FolderWithCount[] };
      setFolders(data.folders ?? []);
    }
  }, []);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ sort, order });
    if (typeFilter) params.set("type", typeFilter);
    const res = await fetch(`/api/assets?${params}`, { credentials: "include" });
    if (res.ok) {
      const data = await res.json() as { assets?: Asset[] };
      setAllAssets(data.assets ?? []);
    }
    setLoading(false);
  }, [sort, order, typeFilter]);

  // Init folders on first mount, then load everything
  useEffect(() => {
    fetch("/api/folders/init", { method: "POST", credentials: "include" })
      .then(() => loadFolders())
      .catch(() => loadFolders());
  }, [loadFolders]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  // Derive filtered/sorted assets
  const assets = useMemo(() => {
    let filtered = allAssets;
    // Folder filter (client-side using asset.folderId)
    if (selectedFolderId !== null) {
      filtered = filtered.filter((a) => a.folderId === selectedFolderId);
    }
    // Search filter
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter((a) => a.filename.toLowerCase().includes(q));
    }
    return clientSort(filtered, sort, order);
  }, [allAssets, selectedFolderId, search, sort, order]);

  // Asset counts per folder
  const assetCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const a of allAssets) {
      if (a.folderId) {
        counts[a.folderId] = (counts[a.folderId] ?? 0) + 1;
      }
    }
    return counts;
  }, [allAssets]);

  const selectedAsset = allAssets.find((a) => a.id === selectedAssetId) ?? null;

  const handleFolderSelect = useCallback((id: string | null) => {
    setSelectedFolderId(id);
    setSelectedAssetId(null);
    setMobileSidebarOpen(false);
  }, []);

  const handleCreateFolder = useCallback(async (parentId: string | null) => {
    const name = window.prompt("Folder name:");
    if (!name?.trim()) return;
    await fetch("/api/folders", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), parentId }),
    });
    loadFolders();
  }, [loadFolders]);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    await fetch(`/api/folders/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    loadFolders();
  }, [loadFolders]);

  const handleDeleteFolder = useCallback(async (id: string) => {
    if (!window.confirm("Delete this folder? Assets will remain unlinked.")) return;
    await fetch(`/api/folders/${id}`, { method: "DELETE", credentials: "include" });
    if (selectedFolderId === id) setSelectedFolderId(null);
    loadFolders();
  }, [loadFolders, selectedFolderId]);

  const sidebarContent = (
    <FolderTree
      folders={folders}
      selectedFolderId={selectedFolderId}
      onSelect={handleFolderSelect}
      onCreateFolder={handleCreateFolder}
      onRenameFolder={handleRenameFolder}
      onDeleteFolder={handleDeleteFolder}
      assetCounts={assetCounts}
    />
  );

  return (
    <div className="h-screen flex flex-col bg-[#1a1a1a] text-white overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-[#1a1a1a] shrink-0">
        {/* Mobile hamburger */}
        <button
          className="md:hidden p-1.5 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          onClick={() => setMobileSidebarOpen(true)}
          aria-label="Open folders"
        >
          ☰
        </button>

        {/* Search */}
        <input
          type="text"
          placeholder="Search files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-52 bg-[#252525] border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 transition-colors"
        />
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — desktop */}
        <aside className="hidden md:block w-56 border-r border-gray-800 shrink-0 overflow-hidden">
          {sidebarContent}
        </aside>

        {/* Sidebar — mobile overlay */}
        {mobileSidebarOpen && (
          <div className="fixed inset-0 z-40 flex md:hidden">
            <div
              className="fixed inset-0 bg-black/60"
              onClick={() => setMobileSidebarOpen(false)}
            />
            <div className="relative z-50 w-64 h-full bg-[#1a1a1a] border-r border-gray-800">
              {sidebarContent}
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-hidden flex min-w-0">
          {selectedAsset ? (
            <AssetDetail
              asset={selectedAsset}
              folders={folders}
              onClose={() => setSelectedAssetId(null)}
              onDeleted={() => {
                setSelectedAssetId(null);
                loadAssets();
              }}
              onMoved={loadAssets}
            />
          ) : (
            <AssetGrid
              assets={assets}
              loading={loading}
              sort={sort}
              order={order}
              typeFilter={typeFilter}
              selectedAssetId={selectedAssetId}
              onSortChange={(s) => setSort(s as SortKey)}
              onOrderChange={(o) => setOrder(o as "asc" | "desc")}
              onTypeFilterChange={setTypeFilter}
              onSelectAsset={setSelectedAssetId}
              onUploaded={loadAssets}
            />
          )}
        </main>
      </div>
    </div>
  );
}
