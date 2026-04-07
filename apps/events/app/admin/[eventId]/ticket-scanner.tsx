'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@imajin/config';

interface GuestInfo {
  attendeeName: string | null;
  ticketType: string;
}

interface TicketScannerProps {
  eventId: string;
  onCheckIn: (ticketId: string) => void;
  lookupGuest?: (ticketId: string) => GuestInfo | undefined;
}

type ScanResult =
  | { type: 'success'; attendeeName: string | null; ticketType: string | null }
  | { type: 'error'; message: string };

function playTone(frequency: number, duration: number) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = frequency;
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, duration);
  } catch {
    // Audio not available — fail silently
  }
}

export function TicketScanner({ eventId, onCheckIn, lookupGuest }: TicketScannerProps) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<import('html5-qrcode').Html5Qrcode | null>(null);
  const recentScans = useRef<Map<string, number>>(new Map());
  const processingRef = useRef(false);

  const stopScanner = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch {
        // Already stopped
      }
      scannerRef.current = null;
    }
  };

  const handleScan = async (ticketId: string) => {
    if (processingRef.current) return;

    const now = Date.now();
    const lastScan = recentScans.current.get(ticketId);
    if (lastScan && now - lastScan < 5000) return;
    recentScans.current.set(ticketId, now);

    processingRef.current = true;

    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets/${ticketId}/check-in`, { method: 'POST' });
      const data = await res.json();

      if (res.ok) {
        playTone(880, 150);
        onCheckIn(ticketId);
        const guest = lookupGuest?.(ticketId);
        setResult({
          type: 'success',
          attendeeName: guest?.attendeeName ?? data.ticket?.attendeeName ?? null,
          ticketType: guest?.ticketType ?? data.ticket?.ticketType ?? null,
        });
      } else {
        playTone(220, 200);
        const msg =
          data.error === 'already checked in' ? '❌ Already checked in'
          : data.error === 'not valid' ? '❌ Ticket not valid'
          : res.status === 404 ? '❌ Ticket not found'
          : res.status === 403 ? '❌ Not authorized'
          : '❌ Check-in failed';
        setResult({ type: 'error', message: msg });
      }
    } catch {
      playTone(220, 200);
      setResult({ type: 'error', message: '❌ Connection error' });
    }

    setTimeout(() => {
      setResult(null);
      processingRef.current = false;
    }, 2500);
  };

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { Html5Qrcode } = await import('html5-qrcode');
      if (!mounted) return;
      const scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;
      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          handleScan,
          () => {},
        );
      } catch {
        if (mounted) setCameraError('Camera unavailable or permission denied.');
      }
    })();

    return () => {
      mounted = false;
      stopScanner();
      processingRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="relative rounded-xl overflow-hidden border border-gray-700 bg-[#0a0a0a]"
      style={{ maxWidth: 480, aspectRatio: '16/9' }}
    >
      {cameraError ? (
        <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm px-4 text-center">
          {cameraError}
        </div>
      ) : (
        <div id="qr-reader" className="w-full h-full" />
      )}

      {result && (
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center text-white text-center px-4 ${
            result.type === 'success' ? 'bg-green-700/90' : 'bg-red-700/90'
          }`}
        >
          {result.type === 'success' ? (
            <>
              <span className="text-4xl mb-2">✅</span>
              {result.attendeeName && (
                <p className="text-lg font-semibold">{result.attendeeName}</p>
              )}
              {result.ticketType && (
                <p className="text-sm text-green-200 mt-1">{result.ticketType}</p>
              )}
              {!result.attendeeName && (
                <p className="text-lg font-semibold">Checked In</p>
              )}
            </>
          ) : (
            <p className="text-lg font-semibold">{result.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
