"use client";

import { useRef, useCallback } from "react";

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
}

export function useLongPress(
  callback: () => void,
  ms: number = 400
): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const start = useCallback(
    (clientX: number, clientY: number) => {
      startPosRef.current = { x: clientX, y: clientY };
      timerRef.current = setTimeout(() => {
        callback();
        timerRef.current = null;
        startPosRef.current = null;
      }, ms);
    },
    [callback, ms]
  );

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const move = useCallback(
    (clientX: number, clientY: number) => {
      if (!startPosRef.current || !timerRef.current) return;
      const dx = Math.abs(clientX - startPosRef.current.x);
      const dy = Math.abs(clientY - startPosRef.current.y);
      // Cancel if moved more than 10px (prevent scroll from triggering long-press)
      if (dx > 10 || dy > 10) {
        cancel();
      }
    },
    [cancel]
  );

  return {
    onTouchStart: useCallback(
      (e: React.TouchEvent) => {
        const touch = e.touches[0];
        start(touch.clientX, touch.clientY);
      },
      [start]
    ),
    onTouchEnd: useCallback(
      (e: React.TouchEvent) => {
        cancel();
      },
      [cancel]
    ),
    onTouchMove: useCallback(
      (e: React.TouchEvent) => {
        const touch = e.touches[0];
        move(touch.clientX, touch.clientY);
      },
      [move]
    ),
    onPointerDown: useCallback(
      (e: React.PointerEvent) => {
        // Only handle primary pointer (mouse left-click or touch)
        if (e.pointerType === "mouse" && e.button !== 0) return;
        start(e.clientX, e.clientY);
      },
      [start]
    ),
    onPointerUp: useCallback(
      (e: React.PointerEvent) => {
        cancel();
      },
      [cancel]
    ),
    onPointerLeave: useCallback(
      (e: React.PointerEvent) => {
        cancel();
      },
      [cancel]
    ),
  };
}
