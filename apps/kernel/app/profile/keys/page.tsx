/* eslint-disable no-console */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { buildPublicUrl } from '@imajin/config';
import { useIdentity } from '../context/IdentityContext';
import {
  buildSignedUpdate,
  generateKeypair,
  hexToBytes,
  hexToMultikey,
  verifyChainClient,
  type MultikeyEntry,
  type VerifiedChainState,
} from './lib/dfos-update';

interface KeysApiResponse {
  did: string;
  singleKey: boolean;
  dfosDid?: string;
  chainLength?: number;
  lastRotated?: string;
  log?: string[];
  headCid?: string;
  message?: string;
}

interface LocalKeypair {
  privateKey: string;
  publicKey: string;
}

function loadLocalKeypair(): LocalKeypair | null {
  if (typeof globalThis.window === 'undefined') return null;
  const raw = localStorage.getItem('imajin_keypair');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function truncateMultibase(multibase: string): string {
  if (multibase.length <= 20) return multibase;
  return `${multibase.slice(0, 12)}…${multibase.slice(-6)}`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return 'Never';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

/** Sign a hex challenge string with a local private key and return a hex signature. */
async function signChallenge(challenge: string, privateKeyHex: string): Promise<string> {
  const ed = await import('@noble/ed25519');
  const msgBytes = new TextEncoder().encode(challenge);
  const privBytes = hexToBytes(privateKeyHex);
  const sigBytes = await ed.signAsync(msgBytes, privBytes);
  return Array.from(sigBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Attempt a silent re-login using a freshly rotated key. Best-effort — never throws. */
async function tryReloginWithKey(did: string, privateKeyHex: string): Promise<boolean> {
  try {
    const challengeRes = await fetch('/auth/api/login/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did }),
    });
    if (!challengeRes.ok) return false;
    const { challengeId, challenge } = await challengeRes.json();
    const signature = await signChallenge(challenge, privateKeyHex);
    const verifyRes = await fetch('/auth/api/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, signature }),
    });
    if (!verifyRes.ok) return false;
    const data = await verifyRes.json();
    return !data.mfaRequired;
  } catch (err) {
    console.error('Silent re-login after rotation failed:', err);
    return false;
  }
}

type RoleName = 'authKeys' | 'assertKeys' | 'controllerKeys';

function KeyList({ title, keys, localMultibase }: Readonly<{
  title: string;
  keys: MultikeyEntry[];
  localMultibase: string | null;
}>) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">{title}</p>
      <ul className="space-y-1">
        {keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between text-sm font-mono text-gray-300 bg-black/40 rounded px-2 py-1">
            <span>{truncateMultibase(k.publicKeyMultibase)}</span>
            {k.publicKeyMultibase === localMultibase && (
              <span className="ml-2 text-xs font-sans text-[#F59E0B]">this device</span>
            )}
          </li>
        ))}
        {keys.length === 0 && <li className="text-sm text-gray-600">None</li>}
      </ul>
    </div>
  );
}

export default function KeysPage() {
  const { did, isLoggedIn, isLoading: identityLoading } = useIdentity();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState<KeysApiResponse | null>(null);
  const [chainState, setChainState] = useState<VerifiedChainState | null>(null);
  const [localMultibase, setLocalMultibase] = useState<string | null>(null);

  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateResult, setRotateResult] = useState<'idle' | 'relogged-in' | 'manual-login'>('idle');

  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!did) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/auth/api/identity/${encodeURIComponent(did)}/keys`);
      if (!res.ok) throw new Error('Failed to load key status');
      const data: KeysApiResponse = await res.json();
      setInfo(data);

      if (!data.singleKey && data.log) {
        setChainState(await verifyChainClient(data.log));
      } else {
        setChainState(null);
      }

      const kp = loadLocalKeypair();
      setLocalMultibase(kp ? await hexToMultikey(kp.publicKey) : null);
    } catch (err: any) {
      console.error('Failed to load key status:', err);
      setError(err.message || 'Failed to load key status');
    } finally {
      setLoading(false);
    }
  }, [did]);

  useEffect(() => {
    if (identityLoading) return;
    if (!isLoggedIn || !did) {
      globalThis.location.href = `${buildPublicUrl('auth')}/login?next=${encodeURIComponent(globalThis.location.href)}`;
      return;
    }
    load();
  }, [identityLoading, isLoggedIn, did, load]);

  function findLocalControllerEntry(): MultikeyEntry | null {
    if (!chainState || !localMultibase) return null;
    return chainState.controllerKeys.find((k) => k.publicKeyMultibase === localMultibase) ?? null;
  }

  async function handleRotate() {
    if (!did || !info?.dfosDid || !info.log || !info.headCid || !chainState) return;
    const kp = loadLocalKeypair();
    if (!kp) {
      setError('No local key found in this browser — cannot rotate from this device.');
      return;
    }

    const controllerEntry = findLocalControllerEntry();
    if (!controllerEntry) {
      setError("This device's key isn't a controller key for this identity, so it can't rotate keys.");
      return;
    }

    setRotating(true);
    setError('');
    try {
      const newKeypair = await generateKeypair();
      const newMultibase = await hexToMultikey(newKeypair.publicKeyHex);

      const replaceCurrent = (keys: MultikeyEntry[]): MultikeyEntry[] =>
        keys.map((k) => ({
          id: k.id,
          publicKeyMultibase: k.publicKeyMultibase === localMultibase ? newMultibase : k.publicKeyMultibase,
        }));

      const { log: newLog, operationCID } = await buildSignedUpdate({
        controllerPrivateKeyHex: kp.privateKey,
        dfosDid: info.dfosDid,
        signingKeyId: controllerEntry.id,
        existingLog: info.log,
        headCid: info.headCid,
        newKeys: {
          authKeys: replaceCurrent(chainState.authKeys),
          assertKeys: replaceCurrent(chainState.assertKeys),
          controllerKeys: replaceCurrent(chainState.controllerKeys),
        },
      });

      const res = await fetch(`/auth/api/identity/${encodeURIComponent(did)}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log: newLog, operationCID }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Rotation failed');
      }

      // Persist the new keypair locally — the DID stays the same, only the
      // underlying signing key changes.
      localStorage.setItem('imajin_keypair', JSON.stringify({
        privateKey: newKeypair.privateKeyHex,
        publicKey: newKeypair.publicKeyHex,
      }));

      setShowRotateConfirm(false);

      // All sessions (including this one) were just invalidated server-side.
      // Try to silently re-establish a session with the new key so the user
      // isn't dropped out; fall back to a manual re-login prompt otherwise.
      const relogged = await tryReloginWithKey(did, newKeypair.privateKeyHex);
      setRotateResult(relogged ? 'relogged-in' : 'manual-login');

      await load();
    } catch (err: any) {
      console.error('Rotation failed:', err);
      setError(err.message || 'Failed to rotate key');
    } finally {
      setRotating(false);
    }
  }

  async function handleRevoke(role: RoleName, entryId: string) {
    if (!did || !info?.dfosDid || !info.log || !info.headCid || !chainState) return;
    const kp = loadLocalKeypair();
    if (!kp) {
      setError('No local key found in this browser — cannot revoke from this device.');
      return;
    }
    const controllerEntry = findLocalControllerEntry();
    if (!controllerEntry) {
      setError("This device's key isn't a controller key for this identity, so it can't revoke devices.");
      return;
    }

    setRevokingId(entryId);
    setError('');
    try {
      const filterOut = (keys: MultikeyEntry[]): MultikeyEntry[] =>
        role === 'authKeys' ? keys.filter((k) => k.id !== entryId) : keys;

      const { log: newLog, operationCID } = await buildSignedUpdate({
        controllerPrivateKeyHex: kp.privateKey,
        dfosDid: info.dfosDid,
        signingKeyId: controllerEntry.id,
        existingLog: info.log,
        headCid: info.headCid,
        newKeys: {
          authKeys: filterOut(chainState.authKeys),
          assertKeys: chainState.assertKeys,
          controllerKeys: chainState.controllerKeys,
        },
      });

      const res = await fetch(`/auth/api/identity/${encodeURIComponent(did)}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log: newLog, operationCID }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Revoke failed');
      }

      await load();
    } catch (err: any) {
      console.error('Revoke failed:', err);
      setError(err.message || 'Failed to revoke device');
    } finally {
      setRevokingId(null);
    }
  }

  if (loading || identityLoading) {
    return (
      <div className="max-w-lg mx-auto text-center">
        <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-[#F59E0B] mb-4"></div>
          <p className="text-gray-400">Loading key status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-white">🔑 Keys &amp; Security</h1>
        <p className="text-gray-400 text-center mb-6">
          Manage the cryptographic keys behind your identity
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-800 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {rotateResult === 'relogged-in' && (
          <div className="mb-4 p-3 bg-green-900/20 border border-green-800 rounded-lg">
            <p className="text-sm text-green-400">Key rotated. All other sessions were logged out — this session has been refreshed with your new key.</p>
          </div>
        )}
        {rotateResult === 'manual-login' && (
          <div className="mb-4 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg">
            <p className="text-sm text-[#F59E0B]">
              Key rotated and all sessions were logged out. Please{' '}
              <a href={`${buildPublicUrl('auth')}/login`} className="underline">log in again</a> with your new key.
            </p>
          </div>
        )}

        {info?.singleKey ? (
          <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-400">
            <p className="mb-2">
              Key management is only available for self-custody identities backed by a DFOS identity
              chain. This account doesn&apos;t have one — nothing to rotate or revoke.
            </p>
            <p>{info.message}</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Chain length</span>
                <span className="text-white font-mono">{info?.chainLength ?? '—'} operations</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Last rotated</span>
                <span className="text-white">{formatTimestamp(info?.lastRotated)}</span>
              </div>
              {chainState && (
                <div className="space-y-3 pt-2 border-t border-gray-800">
                  <KeyList title="Controller keys" keys={chainState.controllerKeys} localMultibase={localMultibase} />
                  <KeyList title="Auth keys (devices)" keys={chainState.authKeys} localMultibase={localMultibase} />
                  <KeyList title="Assert keys" keys={chainState.assertKeys} localMultibase={localMultibase} />
                </div>
              )}
            </div>

            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h3 className="font-medium text-white mb-1">Rotate key</h3>
              <p className="text-sm text-gray-400 mb-3">
                Replace this device&apos;s key with a brand-new one. All sessions everywhere will be
                invalidated and you&apos;ll need to re-authenticate.
              </p>
              {!findLocalControllerEntry() && (
                <p className="text-xs text-gray-600 mb-3">
                  This device&apos;s key isn&apos;t a controller key for this identity, so rotation isn&apos;t available here.
                </p>
              )}
              {!showRotateConfirm ? (
                <button
                  type="button"
                  disabled={!findLocalControllerEntry()}
                  onClick={() => setShowRotateConfirm(true)}
                  className="w-full px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Rotate Key
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
                    <p className="text-sm text-red-400">
                      ⚠️ All sessions will be invalidated. You&apos;ll need to re-authenticate on every
                      device after this. This cannot be undone.
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setShowRotateConfirm(false)}
                      disabled={rotating}
                      className="flex-1 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition text-sm font-medium disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleRotate}
                      disabled={rotating}
                      className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm font-medium disabled:opacity-50"
                    >
                      {rotating ? 'Rotating…' : 'Confirm Rotate'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h3 className="font-medium text-white mb-1">Devices</h3>
              <p className="text-sm text-gray-400 mb-3">
                Revoke a device&apos;s access — e.g. if you lost your phone. Removes its key from the
                identity using your controller key.
              </p>
              <ul className="space-y-2">
                {chainState?.authKeys.map((k) => {
                  const isThisDevice = k.publicKeyMultibase === localMultibase;
                  return (
                    <li key={k.id} className="flex items-center justify-between bg-black/40 rounded px-3 py-2">
                      <span className="text-sm font-mono text-gray-300">
                        {truncateMultibase(k.publicKeyMultibase)}
                        {isThisDevice && <span className="ml-2 text-xs font-sans text-[#F59E0B]">this device</span>}
                      </span>
                      <button
                        type="button"
                        disabled={isThisDevice || !findLocalControllerEntry() || revokingId === k.id}
                        onClick={() => handleRevoke('authKeys', k.id)}
                        className="text-xs px-2 py-1 bg-red-900/40 text-red-300 rounded hover:bg-red-900/60 transition disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {revokingId === k.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {(chainState?.authKeys.length ?? 0) <= 1 && (
                <p className="text-xs text-gray-600 mt-3">
                  No other devices enrolled yet. Adding a second device is coming soon.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
