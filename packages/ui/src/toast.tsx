'use client';

import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  sticky: boolean;
}

type Action =
  | { type: 'ADD'; toast: Toast }
  | { type: 'REMOVE'; id: string };

function reducer(state: Toast[], action: Action): Toast[] {
  switch (action.type) {
    case 'ADD':
      return [...state, action.toast].slice(-5);
    case 'REMOVE':
      return state.filter((t) => t.id !== action.id);
    default:
      return state;
  }
}

interface ToastContextValue {
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    warning: (message: string) => void;
    info: (message: string) => void;
  };
}

const ToastContext = createContext<ToastContextValue | null>(null);

const BORDER_COLORS: Record<ToastType, string> = {
  success: 'border-l-green-500',
  error: 'border-l-red-500',
  warning: 'border-l-amber-500',
  info: 'border-l-blue-500',
};

const DURATIONS: Record<ToastType, number> = {
  success: 4000,
  error: 0,
  warning: 6000,
  info: 4000,
};

function AutoDismiss({
  id,
  duration,
  onDismiss,
}: {
  id: string;
  duration: number;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, onDismiss]);
  return null;
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  return (
    <div
      className={`flex items-start gap-3 bg-surface-surface text-primary px-4 py-3 border-l-4 ${BORDER_COLORS[toast.type]} min-w-[280px] max-w-sm`}
      style={{ animation: 'toastSlideIn 0.2s ease-out' }}
    >
      <p className="flex-1 text-sm">{toast.message}</p>
      <button
        onClick={onDismiss}
        className="text-muted hover:text-primary transition-colors shrink-0 text-lg leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, dispatch] = useReducer(reducer, []);

  const dismiss = useCallback((id: string) => {
    dispatch({ type: 'REMOVE', id });
  }, []);

  const add = useCallback((type: ToastType, message: string) => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now() + Math.random());
    const sticky = type === 'error';
    dispatch({ type: 'ADD', toast: { id, type, message, sticky } });
  }, []);

  const toast = {
    success: (message: string) => add('success', message),
    error: (message: string) => add('error', message),
    warning: (message: string) => add('warning', message),
    info: (message: string) => add('info', message),
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 items-end"
        aria-live="polite"
      >
        <style>{`
          @keyframes toastSlideIn {
            from { transform: translateX(calc(100% + 1rem)); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
        `}</style>
        {toasts.map((t) => (
          <React.Fragment key={t.id}>
            {!t.sticky && DURATIONS[t.type] > 0 && (
              <AutoDismiss id={t.id} duration={DURATIONS[t.type]} onDismiss={dismiss} />
            )}
            <ToastItem toast={t} onDismiss={() => dismiss(t.id)} />
          </React.Fragment>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
