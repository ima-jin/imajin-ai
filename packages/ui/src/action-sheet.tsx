'use client';

import React, { useEffect } from 'react';

interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

interface ReactionsProps {
  emojis: string[];
  onSelect: (emoji: string) => void;
}

interface ActionsProps {
  children: React.ReactNode;
}

interface ActionProps {
  icon?: string;
  label: string;
  onPress: () => void;
  variant?: 'default' | 'danger';
}

function Reactions({ emojis, onSelect }: ReactionsProps) {
  return (
    <div className="flex justify-around px-4 py-3 border-b border-white/[0.1]">
      {emojis.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onSelect(emoji)}
          className="w-11 h-11 flex items-center justify-center text-2xl hover:bg-surface-elevated transition"
          aria-label={emoji}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

function Actions({ children }: ActionsProps) {
  return (
    <div className="border-b border-white/[0.1] last:border-b-0">
      {children}
    </div>
  );
}

function Action({ icon, label, onPress, variant = 'default' }: ActionProps) {
  return (
    <button
      onClick={onPress}
      className={`w-full flex items-center gap-3 px-5 py-3.5 text-left text-sm transition hover:bg-surface-elevated ${
        variant === 'danger' ? 'text-error' : 'text-primary'
      }`}
    >
      {icon && <span className="text-lg w-6 text-center">{icon}</span>}
      <span>{label}</span>
    </button>
  );
}

export function ActionSheet({ open, onClose, title, children }: ActionSheetProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-end">
      <style>{`
        @keyframes actionSheetSlideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-surface-base/60"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Actions'}
        className="relative w-full bg-surface-surface border-t border-white/[0.1] max-h-[70vh] overflow-y-auto"
        style={{ animation: 'actionSheetSlideUp 0.25s ease-out' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-muted" />
        </div>
        {title && (
          <div className="px-5 py-2 border-b border-white/[0.1]">
            <p className="text-sm font-mono font-medium text-muted text-center">{title}</p>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

ActionSheet.Reactions = Reactions;
ActionSheet.Actions = Actions;
ActionSheet.Action = Action;
