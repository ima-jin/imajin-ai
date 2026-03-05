"use client";

import { useState } from "react";
import { ImajinInput, type TranscriptionMeta } from "@imajin/input";

export default function TestPage() {
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 50));
  };

  return (
    <div className="min-h-screen bg-[#1a1a1a] text-gray-100 p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-orange-500 mb-1">Input Test Bench</h1>
          <p className="text-gray-400 text-sm">All features enabled. Try emoji, voice, location, file upload.</p>
        </div>

        <div className="relative">
          <ImajinInput
            features={["emoji", "voice", "files", "location"]}
            placeholder="Type something, or use the buttons..."
            onSubmit={(text) => addLog(`📝 Submit: "${text}"`)}
            onTranscribed={(text) => addLog(`🎤 Transcribed: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`)}
            onTranscriptionMeta={(meta: TranscriptionMeta) => {
              const speedup = meta.durationSeconds > 0
                ? `${(meta.durationSeconds / (meta.processingTimeMs / 1000)).toFixed(0)}x realtime`
                : '';
              addLog(
                `📊 ${meta.source === 'upload' ? 'Voice memo' : 'Mic'} | ` +
                `${meta.durationSeconds.toFixed(1)}s audio → ${meta.processingTimeMs}ms | ` +
                `${speedup} | ${meta.model} | ${meta.language} (${(meta.languageProbability * 100).toFixed(0)}%) | ` +
                `${meta.segmentCount} segments`
              );
            }}
            onLocation={(loc) => addLog(`📍 Location: ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`)}
            onMediaReady={(file) => addLog(`📎 File: ${file.name} (${(file.size/1024).toFixed(0)}KB)`)}
          />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Event Log</h2>
            {log.length > 0 && (
              <button
                onClick={() => setLog([])}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                Clear
              </button>
            )}
          </div>
          <div className="bg-gray-900 rounded-lg p-4 min-h-[200px] max-h-[400px] overflow-y-auto font-mono text-sm">
            {log.length === 0 ? (
              <p className="text-gray-600">Waiting for events...</p>
            ) : (
              log.map((entry, i) => (
                <div key={i} className="py-0.5 text-gray-300">{entry}</div>
              ))
            )}
          </div>
        </div>

        <div className="text-xs text-gray-600 space-y-1">
          <p><strong>Voice:</strong> Requires HTTPS or localhost. Sends to GPU node via /api/transcribe.</p>
          <p><strong>Location:</strong> Requires HTTPS or localhost. Uses browser Geolocation API.</p>
          <p><strong>API routes:</strong> /api/health, /api/transcribe, /api/upload, /api/usage</p>
        </div>
      </div>
    </div>
  );
}
