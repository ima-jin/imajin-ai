"use client";

import React from "react";

interface SelectionToolbarProps {
  count: number;
  total: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDelete: () => void;
  onMove: () => void;
  onSetAccess?: () => void;
  onDownload?: () => void;
}

export const SelectionToolbar = React.memo(function SelectionToolbar({
  count,
  total,
  onSelectAll,
  onClearSelection,
  onDelete,
  onMove,
  onSetAccess,
  onDownload,
}: SelectionToolbarProps) {
  const allSelected = count > 0 && count === total;

  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 px-4 py-2 bg-[#1a1a1a] border-b border-orange-500/30 shrink-0">
      {/* Count + close */}
      <div className="flex items-center gap-2">
        <button
          onClick={onClearSelection}
          className="flex items-center justify-center w-7 h-7 rounded-full hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
          title="Exit selection mode"
          aria-label="Exit selection mode"
        >
          ✕
        </button>
        <span className="text-sm text-orange-400 font-medium whitespace-nowrap">
          {count} selected
        </span>
      </div>

      <div className="flex-1" />

      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={allSelected ? onClearSelection : onSelectAll}
          className="text-xs px-2.5 py-1.5 rounded bg-white/10 text-gray-300 hover:bg-white/20 transition-colors"
        >
          {allSelected ? "Deselect All" : "Select All"}
        </button>

        {onDownload && (
          <button
            onClick={onDownload}
            className="text-xs px-2.5 py-1.5 rounded bg-white/10 text-gray-300 hover:bg-white/20 transition-colors"
          >
            ↓ Download
          </button>
        )}

        <button
          onClick={onMove}
          className="text-xs px-2.5 py-1.5 rounded bg-white/10 text-gray-300 hover:bg-white/20 transition-colors"
        >
          Move
        </button>

        {onSetAccess && (
          <button
            onClick={onSetAccess}
            className="text-xs px-2.5 py-1.5 rounded bg-white/10 text-gray-300 hover:bg-white/20 transition-colors"
          >
            Access
          </button>
        )}

        <button
          onClick={onDelete}
          className="text-xs px-2.5 py-1.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
});

export default SelectionToolbar;
