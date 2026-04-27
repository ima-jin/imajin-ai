"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Folder } from "@/src/db/schema";

export interface FolderTreeProps {
  folders: Folder[];
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  onCreateFolder?: (parentId: string | null) => void;
  onRenameFolder?: (id: string, name: string) => void;
  onDeleteFolder?: (id: string) => void;
  assetCounts?: Record<string, number>;
  collapsed?: boolean;
}

interface FolderNode extends Folder {
  children: FolderNode[];
}

function buildTree(folders: Folder[]): FolderNode[] {
  const map = new Map<string, FolderNode>();
  for (const f of folders) {
    map.set(f.id, { ...f, children: [] });
  }
  const roots: FolderNode[] = [];
  for (const node of Array.from(map.values())) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

interface ContextMenu {
  folderId: string;
  isSystem: boolean;
  x: number;
  y: number;
}

interface FolderRowProps {
  node: FolderNode;
  depth: number;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, folder: FolderNode) => void;
  assetCounts: Record<string, number>;
}

function FolderRow({
  node,
  depth,
  selectedFolderId,
  expandedIds,
  onSelect,
  onToggle,
  onContextMenu,
  assetCounts,
}: FolderRowProps) {
  const isSelected = selectedFolderId === node.id;
  const isExpanded = expandedIds.has(node.id);
  const hasChildren = node.children.length > 0;
  const count = assetCounts[node.id];
  const icon = node.icon ?? "📁";

  return (
    <>
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer select-none transition-colors ${
          isSelected
            ? "bg-imajin-orange text-primary"
            : "text-primary hover:bg-white/10"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(node.id)}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span
          className="w-4 h-4 flex items-center justify-center text-xs shrink-0"
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            onToggle(node.id);
          }}
        >
          {hasChildren ? (isExpanded ? "▼" : "▶") : null}
        </span>
        <span className="text-sm shrink-0">{icon}</span>
        <span className="text-sm truncate flex-1">{node.name}</span>
        {count !== undefined && count > 0 && (
          <span
            className={`text-xs px-1.5 py-0.5 shrink-0 ${
              isSelected ? "bg-white/20 text-primary" : "bg-white/10 text-secondary"
            }`}
          >
            {count}
          </span>
        )}
        <button
          className={`opacity-0 group-hover:opacity-100 p-0.5  text-xs transition-opacity ${
            isSelected ? "text-primary hover:bg-white/20" : "text-secondary hover:bg-white/10"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(e as unknown as React.MouseEvent, node);
          }}
          title="Folder options"
        >
          ···
        </button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <FolderRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedFolderId={selectedFolderId}
            expandedIds={expandedIds}
            onSelect={onSelect}
            onToggle={onToggle}
            onContextMenu={onContextMenu}
            assetCounts={assetCounts}
          />
        ))}
    </>
  );
}

export function FolderTree({
  folders,
  selectedFolderId,
  onSelect,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  assetCounts = {},
  collapsed = false,
}: FolderTreeProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const tree = buildTree(folders);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, folder: FolderNode) => {
      e.preventDefault();
      setContextMenu({ folderId: folder.id, isSystem: folder.isSystem ?? false, x: e.clientX, y: e.clientY });
    },
    []
  );

  const closeMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu, closeMenu]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const startRename = (id: string) => {
    const folder = folders.find((f) => f.id === id);
    if (!folder) return;
    setRenameValue(folder.name);
    setRenamingId(id);
    closeMenu();
  };

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRenameFolder?.(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleDelete = (id: string) => {
    closeMenu();
    onDeleteFolder?.(id);
  };

  const totalCount = Object.values(assetCounts).reduce((s, n) => s + n, 0);

  const treeContent = (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto py-1 space-y-0.5">
        {/* All Files */}
        <div
          className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer select-none transition-colors ${
            selectedFolderId === null
              ? "bg-imajin-orange text-primary"
              : "text-primary hover:bg-white/10"
          }`}
          onClick={() => onSelect(null)}
        >
          <span className="w-4 h-4 shrink-0" />
          <span className="text-sm">🗂️</span>
          <span className="text-sm flex-1">All Files</span>
          {totalCount > 0 && (
            <span
              className={`text-xs px-1.5 py-0.5 ${
                selectedFolderId === null
                  ? "bg-white/20 text-primary"
                  : "bg-white/10 text-secondary"
              }`}
            >
              {totalCount}
            </span>
          )}
        </div>

        {/* Folder tree */}
        {tree.map((node) => (
          <FolderRow
            key={node.id}
            node={node}
            depth={0}
            selectedFolderId={selectedFolderId}
            expandedIds={expandedIds}
            onSelect={onSelect}
            onToggle={toggleExpand}
            onContextMenu={handleContextMenu}
            assetCounts={assetCounts}
          />
        ))}
      </div>

      {/* New Folder button */}
      {onCreateFolder && (
        <div className="pt-2 border-t border-white/10">
          <button
            className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-secondary hover:text-primary hover:bg-white/10 transition-colors"
            onClick={() => onCreateFolder(selectedFolderId)}
          >
            <span>＋</span>
            <span>New Folder</span>
          </button>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-36 bg-[#2a2a2a] border border-white/10 py-1"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {onCreateFolder && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-primary hover:bg-white/10 transition-colors"
              onClick={() => { onCreateFolder(contextMenu.folderId); closeMenu(); }}
            >
              New Subfolder
            </button>
          )}
          {!contextMenu.isSystem && onRenameFolder && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-primary hover:bg-white/10 transition-colors"
              onClick={() => startRename(contextMenu.folderId)}
            >
              Rename
            </button>
          )}
          {!contextMenu.isSystem && onDeleteFolder && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-error hover:bg-white/10 transition-colors"
              onClick={() => handleDelete(contextMenu.folderId)}
            >
              Delete
            </button>
          )}
        </div>
      )}

      {/* Rename overlay */}
      {renamingId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-surface-base/60"
          onClick={() => setRenamingId(null)}
        >
          <div
            className="bg-[#2a2a2a] border border-white/10 p-4 w-72"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-primary mb-2">Rename folder</p>
            <input
              ref={renameInputRef}
              className="w-full bg-[#1a1a1a] border border-white/10 px-3 py-1.5 text-sm text-primary outline-none focus:border-imajin-orange transition-colors"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenamingId(null);
              }}
            />
            <div className="flex gap-2 mt-3 justify-end">
              <button
                className="px-3 py-1 text-sm text-secondary hover:text-primary transition-colors"
                onClick={() => setRenamingId(null)}
              >
                Cancel
              </button>
              <button
                style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="px-3 py-1 text-sm text-primary hover:brightness-110 transition-colors"
                onClick={commitRename}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // Mobile collapsed state: hamburger button
  if (collapsed) {
    return (
      <>
        <button
          className="fixed top-4 left-4 z-40 p-2 bg-[#2a2a2a] border border-white/10 text-primary hover:text-primary transition-colors md:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open folder tree"
        >
          ☰
        </button>
        {mobileOpen && (
          <div className="fixed inset-0 z-40 flex">
            <div role="button" tabIndex={0} aria-label="Close menu" className="fixed inset-0 bg-surface-base/60" onClick={() => setMobileOpen(false)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') setMobileOpen(false); }} />
            <div className="relative z-50 w-64 h-full bg-[#1a1a1a] border-r border-white/10 p-3">
              {treeContent}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="w-full h-full bg-[#1a1a1a] p-3">
      {treeContent}
    </div>
  );
}
