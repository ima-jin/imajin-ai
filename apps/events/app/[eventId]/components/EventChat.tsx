'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { VoiceMessage } from './VoiceMessage';
import { MediaMessage } from './MediaMessage';
import { LocationMessage } from './LocationMessage';

type TextContent = { type?: 'text'; text: string };
type VoiceContent = { type: 'voice'; assetId: string; transcript: string; durationMs: number; waveform?: number[] };
type MediaContent = { type: 'media'; assetId: string; filename: string; mimeType: string; size: number; width?: number; height?: number; caption?: string };
type LocationContent = { type: 'location'; lat: number; lng: number; label?: string; accuracy?: number };
type MessageContent = TextContent | VoiceContent | MediaContent | LocationContent;

interface Message {
  id: string;
  conversationId: string;
  fromDid: string;
  content: MessageContent;
  contentType: string;
  createdAt: string;
}

interface Profile {
  did: string;
  handle?: string;
  name?: string;
}

type RecordingState = 'idle' | 'recording' | 'processing';

const WAVEFORM_BARS = 20;

function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateDivider(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function formatRecordingTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function MessageContentRenderer({ msg, isOwn }: { msg: Message; isOwn: boolean }) {
  const content = msg.content;
  const ct = content.type || msg.contentType || 'text';

  if (ct === 'voice') {
    const v = content as VoiceContent;
    return <VoiceMessage assetId={v.assetId} transcript={v.transcript} durationMs={v.durationMs} waveform={v.waveform} isOwn={isOwn} />;
  }
  if (ct === 'media') {
    const m = content as MediaContent;
    return <MediaMessage assetId={m.assetId} filename={m.filename} mimeType={m.mimeType} size={m.size} width={m.width} height={m.height} caption={m.caption} isOwn={isOwn} />;
  }
  if (ct === 'location') {
    const l = content as LocationContent;
    return <LocationMessage lat={l.lat} lng={l.lng} label={l.label} accuracy={l.accuracy} isOwn={isOwn} />;
  }
  const t = content as TextContent;
  return <p className="text-sm whitespace-pre-wrap">{t.text}</p>;
}

interface EventChatProps {
  eventId: string;
  compact?: boolean;
}

export function EventChat({ eventId, compact = false }: EventChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTicket, setHasTicket] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [currentUserDid, setCurrentUserDid] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Voice recording state
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [waveform, setWaveform] = useState<number[]>(Array(WAVEFORM_BARS).fill(0));
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set(['send:text']));

  const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
  const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3002';
  const INPUT_URL = process.env.NEXT_PUBLIC_INPUT_URL || 'http://localhost:3010';

  // Get current user's DID and resolve capabilities from session tier
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setCurrentUserDid(data.did);
          const tier = data.tier || 'soft';
          if (tier === 'hard') {
            setCapabilities(new Set(['send:text', 'send:voice', 'send:media', 'send:location']));
          } else {
            setCapabilities(new Set(['send:text']));
          }
        }
      } catch (err) {
        console.error('Failed to fetch session:', err);
      }
    }
    fetchSession();
  }, [AUTH_SERVICE_URL]);

  // Check ticket ownership
  useEffect(() => {
    async function checkTicket() {
      try {
        const res = await fetch(`/api/events/${eventId}/my-ticket`);
        if (res.ok) {
          const data = await res.json();
          setHasTicket(data.hasTicket);
          if (!data.hasTicket) {
            setLoading(false);
          }
        } else {
          setHasTicket(false);
          setLoading(false);
        }
      } catch {
        setHasTicket(false);
        setLoading(false);
      }
    }
    checkTicket();
  }, [eventId]);

  // Fetch messages
  const fetchMessages = useCallback(async () => {
    if (hasTicket === false) return;

    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
        credentials: 'include',
      });

      if (!res.ok) {
        if (res.status === 403) {
          setHasTicket(false);
          setLoading(false);
          return;
        }
        throw new Error('Failed to load messages');
      }

      const data = await res.json();
      setMessages(data.messages || []);
      setLoading(false);

      setTimeout(() => {
        if (messagesEndRef.current) {
          messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
      setLoading(false);
    }
  }, [eventId, hasTicket, CHAT_SERVICE_URL]);

  // Initial fetch and polling
  useEffect(() => {
    if (hasTicket === null) return;
    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [fetchMessages, hasTicket]);

  // Resolve profiles for message senders
  useEffect(() => {
    if (!messages.length) return;
    const unknownDids = Array.from(new Set(messages.map(m => m.fromDid))).filter(
      d => !profiles[d]
    );
    if (!unknownDids.length) return;

    unknownDids.forEach(async (did) => {
      try {
        const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`);
        if (res.ok) {
          const data = await res.json();
          setProfiles(prev => ({
            ...prev,
            [did]: { did, handle: data.handle, name: data.name },
          }));
        } else {
          setProfiles(prev => ({ ...prev, [did]: { did } }));
        }
      } catch {
        setProfiles(prev => ({ ...prev, [did]: { did } }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, AUTH_SERVICE_URL]);

  // Send a message with arbitrary content
  const sendMessage = async (content: MessageContent) => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to send message');
      }

      await fetchMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  // Send text message
  const handleSend = async () => {
    if (!message.trim() || sending) return;
    const text = message.trim();
    setMessage('');
    await sendMessage({ type: 'text', text });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Voice recording
  const stopRecordingAnimation = () => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const cancelRecording = useCallback(() => {
    stopRecordingAnimation();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setRecordingState('idle');
    setElapsedMs(0);
    setWaveform(Array(WAVEFORM_BARS).fill(0));
  }, []);

  const startRecording = useCallback(async () => {
    if (recordingState !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        setRecordingState('processing');
        setWaveform(Array(WAVEFORM_BARS).fill(0));

        try {
          const formData = new FormData();
          formData.append('file', blob, 'voice.webm');

          const transcribeForm = new FormData();
          transcribeForm.append('file', blob, 'voice.webm');

          const inputUrl = process.env.NEXT_PUBLIC_INPUT_URL || 'http://localhost:3010';
          const chatUrl = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';

          const [uploadRes, transcribeRes] = await Promise.all([
            fetch(`${inputUrl}/api/upload`, { method: 'POST', body: formData, credentials: 'include' }),
            fetch(`${inputUrl}/api/transcribe`, { method: 'POST', body: transcribeForm, credentials: 'include' }),
          ]);

          if (!uploadRes.ok) throw new Error('Upload failed');
          const uploadData = await uploadRes.json();
          const transcript = transcribeRes.ok ? (await transcribeRes.json()).transcript ?? '' : '';

          const res = await fetch(`${chatUrl}/api/lobby/${eventId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              content: { type: 'voice', assetId: uploadData.assetId, transcript, durationMs },
            }),
          });
          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to send voice message');
          }
          await fetchMessages();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to send voice message');
        } finally {
          setRecordingState('idle');
          setElapsedMs(0);
        }
      };

      recorder.start(100);
      startTimeRef.current = Date.now();
      setRecordingState('recording');

      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 100);

      const drawWaveform = () => {
        if (!analyserRef.current) return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const bars: number[] = [];
        const step = Math.floor(data.length / WAVEFORM_BARS);
        for (let i = 0; i < WAVEFORM_BARS; i++) {
          bars.push(data[i * step] / 255);
        }
        setWaveform(bars);
        animFrameRef.current = requestAnimationFrame(drawWaveform);
      };
      animFrameRef.current = requestAnimationFrame(drawWaveform);
    } catch {
      setRecordingState('idle');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingState, eventId, fetchMessages]);

  const stopRecording = useCallback(() => {
    stopRecordingAnimation();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, []);

  // File upload (media message)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setSending(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${INPUT_URL}/api/upload`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();

      await sendMessage({
        type: 'media',
        assetId: data.assetId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        width: data.width,
        height: data.height,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file');
      setSending(false);
    }
  };

  // Location sharing
  const handleShareLocation = () => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await sendMessage({
          type: 'location',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      () => {
        setError('Unable to get your location');
      }
    );
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecordingAnimation();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const getDisplayName = (did: string): string => {
    const profile = profiles[did];
    if (!profile) return did.slice(0, 16) + '...';
    if (profile.handle) return `@${profile.handle}`;
    if (profile.name) return profile.name;
    return did.slice(0, 16) + '...';
  };

  if (loading) {
    return (
      <div className={`${compact ? 'h-[400px]' : 'flex-1'} flex items-center justify-center`}>
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (hasTicket === false) {
    if (compact) return null;
    return (
      <div className="max-w-4xl mx-auto mt-20">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 text-center">
          <div className="text-6xl mb-4">{'\uD83C\uDFAB'}</div>
          <h2 className="text-2xl font-bold mb-2">Get a Ticket to Join the Conversation</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            You need a ticket to access the event lobby chat. Purchase a ticket to connect with
            other attendees.
          </p>
          <Link
            href={`/${eventId}#tickets`}
            className="inline-block px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-lg transition"
          >
            View Tickets
          </Link>
        </div>
      </div>
    );
  }

  const messagesAreaClass = compact
    ? 'h-[400px] overflow-y-auto space-y-4 mb-4 scrollbar-dark'
    : 'flex-1 overflow-y-auto space-y-4 mb-4 scrollbar-dark';

  return (
    <div className={compact ? '' : 'flex flex-col flex-1'}>
      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {/* Messages */}
      <div className={messagesAreaClass}>
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 mt-8">
            <p className="text-4xl mb-2">{'\uD83D\uDCAC'}</p>
            <p>No messages yet. Start the conversation!</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isOwn = msg.fromDid === currentUserDid;
            const prevMsg = messages[index - 1];
            const showDateDivider =
              !prevMsg ||
              new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();

            return (
              <div key={msg.id}>
                {showDateDivider && (
                  <div className="flex items-center justify-center my-4">
                    <span className="px-3 py-1 bg-gray-100 dark:bg-gray-800 rounded-full text-xs text-gray-500">
                      {formatDateDivider(msg.createdAt)}
                    </span>
                  </div>
                )}

                <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[70%]">
                    {!isOwn && (!prevMsg || prevMsg.fromDid !== msg.fromDid || showDateDivider) && (
                      <p className="text-xs text-orange-500 mb-1 ml-3 font-medium">
                        {getDisplayName(msg.fromDid)}
                      </p>
                    )}

                    <div
                      className={`px-4 py-2 rounded-2xl ${
                        isOwn
                          ? 'bg-orange-500 text-white rounded-br-md'
                          : 'bg-gray-100 dark:bg-gray-800 rounded-bl-md'
                      }`}
                    >
                      <MessageContentRenderer msg={msg} isOwn={isOwn} />
                    </div>

                    <p className={`text-xs text-gray-400 mt-1 ${isOwn ? 'text-right mr-1' : 'ml-3'}`}>
                      {formatMessageTime(msg.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="bg-white dark:bg-gray-900 pt-4 border-t border-gray-200 dark:border-gray-700">
        {recordingState !== 'idle' ? (
          /* Voice recording UI */
          <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2">
            {recordingState === 'processing' ? (
              <span className="text-sm text-gray-500 flex-1">Processing...</span>
            ) : (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
                <span className="text-sm font-mono text-red-500 flex-shrink-0 w-10">
                  {formatRecordingTime(elapsedMs)}
                </span>
                <div className="flex items-center gap-px flex-1 h-8">
                  {waveform.map((val, i) => (
                    <div
                      key={i}
                      className="flex-1 bg-orange-500 dark:bg-orange-400 rounded-full transition-all duration-75"
                      style={{ height: `${Math.max(4, val * 28)}px` }}
                    />
                  ))}
                </div>
                <button
                  onClick={cancelRecording}
                  className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg text-gray-500 flex-shrink-0"
                  title="Cancel"
                >
                  {'\u2715'}
                </button>
                <button
                  onClick={stopRecording}
                  className="p-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded-lg flex-shrink-0"
                  title="Send"
                >
                  {'\u23F9'}
                </button>
              </>
            )}
          </div>
        ) : (
          /* Normal input */
          <div className="flex items-end gap-2">
            {/* File upload */}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
            />
            {capabilities.has('send:media') ? (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                className="p-2.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition disabled:opacity-50 text-gray-500 flex-shrink-0"
                title="Attach file"
              >
                {'\uD83D\uDCCE'}
              </button>
            ) : (
              <div
                className="p-2.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
                title="Verify your identity to send files"
              >
                🔒
              </div>
            )}

            {/* Text input */}
            <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                className="w-full bg-transparent resize-none outline-none text-sm max-h-32"
                rows={1}
              />
            </div>

            {/* Location */}
            {capabilities.has('send:location') ? (
              <button
                onClick={handleShareLocation}
                disabled={sending}
                className="p-2.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition disabled:opacity-50 text-gray-500 flex-shrink-0"
                title="Share location"
              >
                {'\uD83D\uDCCD'}
              </button>
            ) : (
              <div
                className="p-2.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
                title="Verify your identity to share location"
              >
                🔒
              </div>
            )}

            {/* Voice record */}
            {capabilities.has('send:voice') ? (
              <button
                onClick={startRecording}
                disabled={sending}
                className="p-2.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition disabled:opacity-50 text-gray-500 flex-shrink-0"
                title="Record voice message"
              >
                {'\uD83C\uDFA4'}
              </button>
            ) : (
              <div
                className="p-2.5 opacity-50 cursor-not-allowed text-gray-400 flex-shrink-0"
                title="Verify your identity to send voice messages"
              >
                🔒
              </div>
            )}

            {/* Send */}
            <button
              onClick={handleSend}
              disabled={!message.trim() || sending}
              className={`p-3 rounded-full transition flex-shrink-0 ${
                message.trim() && !sending
                  ? 'bg-orange-500 text-white hover:bg-orange-600'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400'
              }`}
            >
              {sending ? '...' : '\u27A4'}
            </button>
          </div>
        )}
        <p className="text-xs text-gray-400 text-center mt-2">
          Visible to all ticket holders
        </p>
      </div>
    </div>
  );
}
