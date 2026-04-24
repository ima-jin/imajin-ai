'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { buildPublicUrl } from '@imajin/config';
import ProfileCard from './ProfileCard';

// ─── Types ────────────────────────────────────────────────────────────────────

type BumpState =
  | 'idle'
  | 'selecting'
  | 'active'
  | 'matching'
  | 'confirming'
  | 'connected'
  | 'already_connected';

interface BumpNode {
  id: string;
  name: string;
  type: string;
  location?: { lat: number; lng: number };
  distanceM?: number;
}

interface BumpSession {
  sessionId: string;
  nodeId: string;
  expiresAt: string;
}

interface BumpPeer {
  did: string;
  handle: string;
  name?: string;
}

interface BumpMatch {
  matchId: string;
  peer: BumpPeer;
  expiresAt: string;
}

interface BumpConnectedInfo {
  connectionId: string;
  peer: BumpPeer;
}

interface Props {
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch {}
}

function chatUrlToWsUrl(chatUrl: string): string {
  return chatUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

const EXPIRY_OPTIONS: { label: string; value: 1 | 5 | 15 | 75 }[] = [
  { label: '1 min', value: 1 },
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '75 min', value: 75 },
];

const REGISTRY_URL = '/registry/api/bump';
const CHAT_URL = buildPublicUrl('chat');

// ─── Main component ───────────────────────────────────────────────────────────

export default function BumpConnect({ onClose }: Props) {
  const [state, setState] = useState<BumpState>('selecting');

  // Selecting state
  const [nodes, setNodes] = useState<BumpNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<BumpNode | null>(null);
  const [expiry, setExpiry] = useState<1 | 5 | 15 | 75>(5);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [loadingNodes, setLoadingNodes] = useState(true);

  // Session
  const [session, setSession] = useState<BumpSession | null>(null);
  const sessionRef = useRef<BumpSession | null>(null);
  const locationRef = useRef<{ lat: number; lng: number } | null>(null);

  // Active state
  const [timeRemaining, setTimeRemaining] = useState<number>(0); // seconds

  // Matching state
  const matchingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Confirming state
  const [match, setMatch] = useState<BumpMatch | null>(null);
  const [peerConfirmed, setPeerConfirmed] = useState(false);
  const [confirmTimeLeft, setConfirmTimeLeft] = useState<number>(60);
  const confirmTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoDeclineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connected state
  const [connectedInfo, setConnectedInfo] = useState<BumpConnectedInfo | null>(null);
  const [showGreenFlash, setShowGreenFlash] = useState(false);

  // Already connected state
  const [alreadyConnectedPeer, setAlreadyConnectedPeer] = useState<{ did: string; handle?: string; name?: string; avatar?: string } | null>(null);
  const [alreadyConnectedSince, setAlreadyConnectedSince] = useState<string | null>(null);

  // Accelerometer
  const accelBuffer = useRef<number[]>([]);
  const rotBuffer = useRef<number[]>([]);
  const lastEventSent = useRef<number>(0);
  const deviceMotionHandler = useRef<((e: DeviceMotionEvent) => void) | null>(null);
  const [debugMag, setDebugMag] = useState<number>(0);
  const [debugPeak, setDebugPeak] = useState<number>(0);
  const [debugHasMotion, setDebugHasMotion] = useState<boolean | null>(null);
  const [debugRaw, setDebugRaw] = useState<string>('—');
  const peakRef = useRef<number>(0);

  // WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  const wsMounted = useRef(true);
  const wsReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsReconnectDelay = useRef(1000);

  // ─── Geolocation ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      fetchNodes(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        locationRef.current = loc;
        fetchNodes(loc);
      },
      () => {
        setGeoError('Location unavailable — showing all nodes');
        fetchNodes(null);
      },
      { timeout: 5000 }
    );
  }, []);

  async function fetchNodes(loc: { lat: number; lng: number } | null) {
    setLoadingNodes(true);
    try {
      const params = loc ? `?lat=${loc.lat}&lng=${loc.lng}` : '';
      const res = await fetch(`${REGISTRY_URL}/nodes${params}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setNodes(data.nodes || []);
        if (data.nodes?.length > 0) setSelectedNode(data.nodes[0]);
      }
    } catch {}
    setLoadingNodes(false);
  }

  // ─── WebSocket ───────────────────────────────────────────────────────────────

  const handleWsMessage = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    if (type === 'bump:matched') {
      const peer = data.peer as BumpPeer;
      const matchId = data.matchId as string;
      const expiresAt = data.expiresAt as string;
      if (matchingTimer.current) clearTimeout(matchingTimer.current);
      setState('confirming');
      setMatch({ matchId, peer, expiresAt });
      setPeerConfirmed(false);
      vibrate([100, 50, 100]);
      startConfirmCountdown(expiresAt, matchId);
    }

    if (type === 'bump:peer_confirmed') {
      setPeerConfirmed(true);
    }

    if (type === 'bump:connected') {
      const peer = data.peer as BumpPeer;
      const connectionId = data.connectionId as string;
      const redirectUrl = data.redirectUrl as string | undefined;
      clearConfirmTimers();
      setState('connected');
      setConnectedInfo({ connectionId, peer });
      setShowGreenFlash(true);
      vibrate([100, 50, 100, 50, 100]);
      setTimeout(() => setShowGreenFlash(false), 500);
      setTimeout(() => {
        if (redirectUrl) {
          // External URLs only allowed if they start with / (kernel route) or same origin
          if (redirectUrl.startsWith('/')) {
            window.location.href = redirectUrl;
          } else {
            try {
              const url = new URL(redirectUrl);
              if (url.origin === window.location.origin) {
                window.location.href = redirectUrl;
              } else {
                // External URL — open in new tab for safety, stay in bump
                window.open(redirectUrl, '_blank', 'noopener');
                setState(session ? 'active' : 'idle');
              }
            } catch {
              setState(session ? 'active' : 'idle');
            }
          }
        } else {
          setState(session ? 'active' : 'idle');
        }
      }, 3000);
    }

    if (type === 'bump:match_expired') {
      clearConfirmTimers();
      setState(session ? 'active' : 'idle');
    }

    if (type === 'bump:already_connected') {
      if (matchingTimer.current) clearTimeout(matchingTimer.current);
      const peer = data.peer as { did: string; handle?: string; name?: string; avatar?: string };
      const connectedAt = data.connectedAt as string;
      setAlreadyConnectedPeer(peer);
      setAlreadyConnectedSince(connectedAt);
      setState('already_connected');
      vibrate([100, 50, 100]);
    }
  }, [session]);

  const connectWs = useCallback(() => {
    if (!wsMounted.current) return;
    if (wsReconnectTimer.current) clearTimeout(wsReconnectTimer.current);

    const wsUrl = `${chatUrlToWsUrl(CHAT_URL)}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;
        if (data.type === 'pong') return;
        if (data.type === 'auth_required') {
          fetch(`${CHAT_URL}/api/ws-token`, { credentials: 'include' })
            .then(res => res.ok ? res.json() : null)
            .then(tokenData => {
              if (tokenData?.token && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'auth', token: tokenData.token }));
              }
            })
            .catch(() => {});
          return;
        }
        if (data.type === 'connected') {
          wsReconnectDelay.current = 1000;
          return;
        }
        handleWsMessage(data);
      } catch {}
    };

    ws.onclose = () => {
      if (wsMounted.current) {
        wsReconnectTimer.current = setTimeout(() => {
          wsReconnectDelay.current = Math.min(wsReconnectDelay.current * 2, 30000);
          connectWs();
        }, wsReconnectDelay.current);
      }
    };

    ws.onerror = () => { ws.close(); };
  }, [handleWsMessage]);

  useEffect(() => {
    wsMounted.current = true;
    connectWs();
    return () => {
      wsMounted.current = false;
      if (wsReconnectTimer.current) clearTimeout(wsReconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connectWs]);

  // ─── Session countdown ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!session || state !== 'active') return;
    const expiresAt = new Date(session.expiresAt).getTime();
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setTimeRemaining(left);
      if (left === 0) {
        deactivate(session.sessionId);
        setState('idle');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [session, state]);

  // ─── Confirm countdown ───────────────────────────────────────────────────────

  function startConfirmCountdown(expiresAt: string, matchId: string) {
    clearConfirmTimers();
    const end = new Date(expiresAt).getTime();
    const tick = () => {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      setConfirmTimeLeft(left);
    };
    tick();
    confirmTimer.current = setInterval(tick, 1000);
    autoDeclineTimer.current = setTimeout(() => {
      handleConfirm(matchId, false);
    }, Math.max(0, end - Date.now()));
  }

  function clearConfirmTimers() {
    if (confirmTimer.current) clearInterval(confirmTimer.current);
    if (autoDeclineTimer.current) clearTimeout(autoDeclineTimer.current);
    confirmTimer.current = null;
    autoDeclineTimer.current = null;
  }

  useEffect(() => () => clearConfirmTimers(), []);

  // ─── Accelerometer ───────────────────────────────────────────────────────────

  function startAccelerometer() {
    let frameCount = 0;
    const handler = (e: DeviceMotionEvent) => {
      if (!debugHasMotion) setDebugHasMotion(true);
      const hasAccel = !!(e.acceleration?.x || e.acceleration?.y || e.acceleration?.z);
      const acc = hasAccel ? e.acceleration! : e.accelerationIncludingGravity;
      const rot = e.rotationRate;

      const ax = acc?.x ?? 0;
      const ay = acc?.y ?? 0;
      const az = acc?.z ?? 0;
      const mag = Math.sqrt(ax * ax + ay * ay + az * az);

      accelBuffer.current.push(mag);
      if (accelBuffer.current.length > 30) accelBuffer.current.shift();

      const ra = rot?.alpha ?? 0;
      const rb = rot?.beta ?? 0;
      const rg = rot?.gamma ?? 0;
      const rmag = Math.sqrt(ra * ra + rb * rb + rg * rg);
      rotBuffer.current.push(rmag);
      if (rotBuffer.current.length > 30) rotBuffer.current.shift();

      // Track peak
      if (mag > peakRef.current) peakRef.current = mag;

      // Update debug display every 10 frames
      frameCount++;
      if (frameCount % 10 === 0) {
        setDebugMag(Math.round(mag * 10) / 10);
        setDebugPeak(Math.round(peakRef.current * 10) / 10);
        setDebugRaw(
          `a:${e.acceleration?.x?.toFixed(1)},${e.acceleration?.y?.toFixed(1)},${e.acceleration?.z?.toFixed(1)} ` +
          `ag:${e.accelerationIncludingGravity?.x?.toFixed(1)},${e.accelerationIncludingGravity?.y?.toFixed(1)},${e.accelerationIncludingGravity?.z?.toFixed(1)} ` +
          `int:${e.interval?.toFixed(0)}ms`
        );
      }

      // Spike threshold: 15 if we have pure acceleration, 20 if gravity-included
      const threshold = hasAccel ? 15 : 20;
      if (mag > threshold) {
        const now = Date.now();
        if (now - lastEventSent.current < 1000) return;
        lastEventSent.current = now;

        setTimeout(() => {
          const waveform = [...accelBuffer.current];
          const rotationRate = [...rotBuffer.current];
          sendBumpEvent(waveform, rotationRate);
        }, 250);
      }
    };

    deviceMotionHandler.current = handler;
    window.addEventListener('devicemotion', handler);
  }

  function stopAccelerometer() {
    if (deviceMotionHandler.current) {
      window.removeEventListener('devicemotion', deviceMotionHandler.current);
      deviceMotionHandler.current = null;
    }
  }

  async function sendBumpEvent(waveform: number[], rotationRate: number[]) {
    const sess = sessionRef.current;
    if (!sess) return;
    setState('matching');
    vibrate(50);

    try {
      const res = await fetch(`${REGISTRY_URL}/event`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sess.sessionId,
          waveform,
          rotationRate,
          timestamp: Date.now(),
          location: locationRef.current ?? undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.matched) return; // WS bump:matched will arrive
      }
    } catch {}

    // No match from HTTP — wait 3s then return to active
    matchingTimer.current = setTimeout(() => {
      setState('active');
    }, 3000);
  }

  // ─── Start bumping ────────────────────────────────────────────────────────────

  async function startBumping() {
    if (!selectedNode) return;

    // iOS DeviceMotion permission — must be called from user gesture
    if (typeof DeviceMotionEvent !== 'undefined') {
      const dme = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      };
      if (typeof dme.requestPermission === 'function') {
        try {
          const result = await dme.requestPermission();
          if (result !== 'granted') return;
        } catch {}
      }
    }

    try {
      const res = await fetch(`${REGISTRY_URL}/activate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: selectedNode.id,
          expiryMinutes: expiry,
          location: locationRef.current ?? undefined,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setSession(data);
      sessionRef.current = data;
      setState('active');
      vibrate(100);
      startAccelerometer();
    } catch {}
  }

  // ─── Stop / deactivate ────────────────────────────────────────────────────────

  async function deactivate(sessionId: string) {
    stopAccelerometer();
    if (matchingTimer.current) clearTimeout(matchingTimer.current);
    try {
      await fetch(`${REGISTRY_URL}/deactivate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch {}
  }

  function handleStop() {
    if (session) deactivate(session.sessionId);
    setSession(null);
    sessionRef.current = null;
    setState('idle');
  }

  useEffect(() => {
    return () => {
      stopAccelerometer();
      if (session) deactivate(session.sessionId);
      if (matchingTimer.current) clearTimeout(matchingTimer.current);
    };
  }, []);

  // ─── Confirm / decline ────────────────────────────────────────────────────────

  async function handleConfirm(matchId: string, accept: boolean) {
    clearConfirmTimers();
    try {
      await fetch(`${REGISTRY_URL}/confirm`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, accept }),
      });
    } catch {}
    if (!accept) {
      setState(session ? 'active' : 'idle');
    }
    // If accept:true, wait for bump:connected WS event
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  const nodeName = selectedNode?.name ?? '';
  const isActive = state === 'active' || state === 'matching';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ backgroundColor: '#0a0a0a' }}
    >
      {/* Green flash overlay */}
      {showGreenFlash && (
        <div
          className="absolute inset-0 z-50 pointer-events-none transition-opacity duration-500"
          style={{ backgroundColor: 'rgba(34,197,94,0.2)' }}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between p-4 shrink-0">
        <button
          onClick={() => {
            if (isActive && session) deactivate(session.sessionId);
            onClose();
          }}
          className="text-gray-500 hover:text-gray-300 transition p-2 min-h-[48px] min-w-[48px] flex items-center justify-center"
        >
          ✕
        </button>
        <span className="text-gray-500 text-sm">Bump Connect</span>
        <div className="w-12" />
      </div>

      {/* ── Selecting ─────────────────────────────────────────────────────────── */}
      {state === 'selecting' && (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <h2 className="text-white text-2xl font-bold mb-1">Find nearby people</h2>
          <p className="text-gray-400 text-sm mb-6">Bump phones to connect instantly</p>

          {geoError && (
            <p className="text-amber-400/70 text-xs mb-4">{geoError}</p>
          )}

          {/* Node list */}
          <div className="mb-6">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Select a node</p>
            {loadingNodes ? (
              <div className="text-gray-500 text-sm py-4">Finding nearby nodes...</div>
            ) : nodes.length === 0 ? (
              <div className="text-gray-500 text-sm py-4">No nodes found nearby.</div>
            ) : (
              <div className="space-y-2">
                {nodes.map((node) => (
                  <button
                    key={node.id}
                    onClick={() => setSelectedNode(node)}
                    className={`w-full text-left p-4 rounded-xl border transition min-h-[48px] ${
                      selectedNode?.id === node.id
                        ? 'border-orange-500 bg-orange-500/10 text-white'
                        : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'
                    }`}
                  >
                    <div className="font-medium">{node.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {node.type}
                      {node.distanceM != null && ` · ${node.distanceM < 1000
                        ? `${Math.round(node.distanceM)}m`
                        : `${(node.distanceM / 1000).toFixed(1)}km`} away`}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Expiry */}
          <div className="mb-8">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Active for</p>
            <div className="flex gap-2">
              {EXPIRY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setExpiry(opt.value)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition min-h-[48px] ${
                    expiry === opt.value
                      ? 'bg-orange-500 text-black'
                      : 'bg-white/10 text-gray-400 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={startBumping}
            disabled={!selectedNode || loadingNodes}
            className="w-full py-4 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-black font-bold text-lg rounded-xl transition min-h-[48px]"
          >
            Start Bumping
          </button>
        </div>
      )}

      {/* ── Active ────────────────────────────────────────────────────────────── */}
      {(state === 'active' || state === 'matching') && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 relative overflow-hidden">
          {/* Ambient glow */}
          <div
            className="absolute w-72 h-72 rounded-full"
            style={{
              backgroundColor: '#f97316',
              animation: state === 'matching'
                ? 'bump-breathe 0.6s ease-in-out infinite'
                : 'bump-breathe 2.5s ease-in-out infinite',
              filter: 'blur(60px)',
            }}
          />

          <div className="relative z-10 text-center">
            {state === 'matching' ? (
              <>
                <p className="text-white text-3xl font-bold mb-2">Matching...</p>
                <p className="text-gray-400 text-base">Hold still</p>
              </>
            ) : (
              <>
                <p className="text-white text-3xl font-bold mb-2">Bump to connect</p>
                <p className="text-orange-400 text-base">{nodeName}</p>
              </>
            )}

            {/* Time remaining */}
            {state === 'active' && timeRemaining > 0 && (
              <p className="text-gray-600 text-sm mt-4">
                {Math.floor(timeRemaining / 60)}:{String(timeRemaining % 60).padStart(2, '0')} remaining
              </p>
            )}

            {/* Debug: accelerometer readings */}
            {state === 'active' && (
              <div className="mt-6 text-gray-300 text-xs font-mono space-y-0.5 bg-black/80 p-3 rounded-lg">
                <p>mag: <span className={debugMag > 15 ? 'text-green-400 font-bold' : ''}>{debugMag} m/s²</span> (threshold: {debugRaw.startsWith('a:null') || debugRaw.includes('a:undefined') ? '20' : '15'})</p>
                <p>motion: {debugHasMotion === null ? 'waiting…' : debugHasMotion ? '✓' : '✗ no events'}</p>
                <p>peak: <span className="text-amber-400">{debugPeak} m/s²</span></p>
                <p className="break-all text-gray-500">{debugRaw}</p>
              </div>
            )}
          </div>

          {/* BumpIndicator pill (minimized version within active state) */}
          <div
            className="absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full"
            style={{ backgroundColor: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.3)' }}
          >
            <span
              className="w-2 h-2 rounded-full bg-orange-500"
              style={{ animation: 'bump-breathe 1.5s ease-in-out infinite' }}
            />
            <span className="text-orange-400 text-xs font-medium">Bumping</span>
          </div>

          {/* Stop button */}
          <button
            onClick={handleStop}
            className="absolute bottom-8 left-1/2 -translate-x-1/2 px-10 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl transition text-base font-medium min-h-[48px]"
          >
            Stop
          </button>
        </div>
      )}

      {/* ── Confirming ────────────────────────────────────────────────────────── */}
      {state === 'confirming' && match && (
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="mb-8">
            <ProfileCard
              handle={match.peer.handle}
              name={match.peer.name}
              label={peerConfirmed ? `✓ @${match.peer.handle} accepted` : undefined}
              labelColor="text-green-400"
              note={`Met at ${nodeName} · ${confirmTimeLeft}s to decide`}
            />
          </div>

          <div className="w-full space-y-3">
            <button
              onClick={() => handleConfirm(match.matchId, true)}
              className="w-full py-4 bg-orange-500 hover:bg-orange-600 text-black font-bold text-lg rounded-xl transition min-h-[48px]"
            >
              Connect
            </button>
            <button
              onClick={() => handleConfirm(match.matchId, false)}
              className="w-full py-3 bg-white/10 hover:bg-white/15 text-gray-400 rounded-xl transition text-base min-h-[48px]"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* ── Connected ─────────────────────────────────────────────────────────── */}
      {state === 'connected' && connectedInfo && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="text-5xl mb-4">🤝</div>
          <p className="text-white text-2xl font-bold">
            Connected with @{connectedInfo.peer.handle}
          </p>
          <p className="text-gray-500 text-sm mt-3">Taking you to their profile…</p>
        </div>
      )}

      {/* ── Already Connected ────────────────────────────────────────────── */}
      {state === 'already_connected' && alreadyConnectedPeer && (
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <ProfileCard
            handle={alreadyConnectedPeer.handle}
            name={alreadyConnectedPeer.name}
            avatar={alreadyConnectedPeer.avatar}
            label="Already connected"
            labelColor="text-orange-400"
            note={alreadyConnectedSince
              ? `Connected since ${new Date(alreadyConnectedSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
              : undefined
            }
          />
          <button
            onClick={() => setState(session ? 'active' : 'idle')}
            className="mt-8 px-8 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl transition text-base font-medium min-h-[48px]"
          >
            Back to bumping
          </button>
        </div>
      )}

      {/* ── Idle ─────────────────────────────────────────────────────────────── */}
      {state === 'idle' && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="text-5xl mb-4">🤜🤛</div>
          <p className="text-white text-xl font-semibold mb-2">Session ended</p>
          <p className="text-gray-500 text-sm mb-8">Start a new session to keep bumping</p>
          <button
            onClick={() => setState('selecting')}
            className="px-8 py-3 bg-orange-500 hover:bg-orange-600 text-black font-bold rounded-xl transition min-h-[48px]"
          >
            Start Again
          </button>
        </div>
      )}

      {/* CSS keyframes injected inline */}
      <style>{`
        @keyframes bump-breathe {
          0%, 100% { opacity: 0.3; transform: scale(0.95); }
          50%       { opacity: 0.6; transform: scale(1.05); }
        }
      `}</style>
    </div>
  );
}
