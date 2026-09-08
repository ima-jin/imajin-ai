'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Chat } from '@imajin/chat';
import { apiFetch, buildPublicUrl } from '@imajin/config';
import type { NameDisplayPolicy } from '@imajin/chat';

const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';

interface Profile {
  did: string;
  handle?: string;
  name?: string;
}

interface EventChatWrapperProps {
  did: string;
  eventId: string;
  compact?: boolean;
}

type DisplayPref = 'real_name' | 'handle' | 'anonymous';

/** Assigns (and remembers) a stable 1-based attendee number for anonymous display. */
function getOrAssignAttendeeIndex(senderDid: string, senderIndexMap: Map<string, number>, nextIndexRef: { current: number }): number {
  if (!senderIndexMap.has(senderDid)) {
    senderIndexMap.set(senderDid, nextIndexRef.current);
    nextIndexRef.current += 1;
  }
  return senderIndexMap.get(senderDid)!;
}

/** Resolves the display policy that actually applies to this sender's message. */
function resolveEffectivePolicy(nameDisplayPolicy: NameDisplayPolicy, isOwnMessage: boolean, myDisplayPref: DisplayPref): DisplayPref {
  if (nameDisplayPolicy === 'attendee_choice') return isOwnMessage ? myDisplayPref : 'handle';
  return nameDisplayPolicy as DisplayPref;
}

function resolveRealNameDisplay(senderDid: string, profile: Profile | undefined, names: Record<string, string>, fetchProfile: (senderDid: string) => void): string {
  if (profile?.name) return profile.name;
  if (names[senderDid]) return names[senderDid]; // useChatNames may already have the name
  if (profile?.handle) return `@${profile.handle}`;
  // Trigger lazy fetch and fallback
  fetchProfile(senderDid);
  return `${senderDid.slice(0, 16)}...`;
}

function resolveHandleDisplay(senderDid: string, profile: Profile | undefined, names: Record<string, string>, fetchProfile: (senderDid: string) => void): string {
  if (profile?.handle) return `@${profile.handle}`;
  // If we only have a name in didNames but want handle, try to fetch
  fetchProfile(senderDid);
  if (names[senderDid]?.startsWith('@')) return names[senderDid];
  return `${senderDid.slice(0, 16)}...`;
}

export function EventChatWrapper({ did, eventId, compact }: Readonly<EventChatWrapperProps>) {
  const [nameDisplayPolicy, setNameDisplayPolicy] = useState<NameDisplayPolicy>('attendee_choice');
  const [myDisplayPref, setMyDisplayPref] = useState<'real_name' | 'handle' | 'anonymous'>('handle');
  const [currentUserDid, setCurrentUserDid] = useState<string | null>(null);
  const profilesRef = useRef<Record<string, Profile>>({});
  const senderIndexMap = useRef<Map<string, number>>(new Map());
  const nextIndex = useRef(0);
  const fetchingRef = useRef<Set<string>>(new Set());

  const authUrl = buildPublicUrl('auth');

  // Get current user's DID
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`${authUrl}/api/session`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setCurrentUserDid(data.did ?? null);
        }
      } catch {
        // ignore
      }
    }
    fetchSession();
  }, [authUrl]);

  // Load attendee display pref from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(`eventChat_displayPref_${eventId}`);
    if (stored && ['real_name', 'handle', 'anonymous'].includes(stored)) {
      setMyDisplayPref(stored as 'real_name' | 'handle' | 'anonymous');
    }
  }, [eventId]);

  // Fetch event name display policy
  useEffect(() => {
    async function fetchPolicy() {
      try {
        const res = await apiFetch(`/api/events/${eventId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.event?.nameDisplayPolicy) {
            setNameDisplayPolicy(data.event.nameDisplayPolicy as NameDisplayPolicy);
          }
        }
      } catch {
        // fallback to default
      }
    }
    fetchPolicy();
  }, [eventId]);

  // Lazily fetch a profile for name/handle resolution
  const fetchProfile = useCallback(async (senderDid: string) => {
    if (profilesRef.current[senderDid] || fetchingRef.current.has(senderDid)) return;
    fetchingRef.current.add(senderDid);
    try {
      const res = await fetch(`${authUrl}/api/lookup/${encodeURIComponent(senderDid)}`);
      if (res.ok) {
        const data = await res.json();
        profilesRef.current[senderDid] = {
          did: senderDid,
          handle: data.handle,
          name: data.name,
        };
      } else {
        profilesRef.current[senderDid] = { did: senderDid };
      }
    } catch {
      profilesRef.current[senderDid] = { did: senderDid };
    }
  }, [authUrl]);

  const resolveDisplayName = useCallback((senderDid: string, names: Record<string, string>, userDid?: string): string | undefined => {
    const isOwnMessage = !!userDid && senderDid === userDid;

    // For anonymous policy, build attendee numbers based on first-seen order
    if (nameDisplayPolicy === 'anonymous') {
      const idx = getOrAssignAttendeeIndex(senderDid, senderIndexMap.current, nextIndex);
      return `Attendee #${idx + 1}`;
    }

    // Determine effective policy for this sender
    const effectivePolicy = resolveEffectivePolicy(nameDisplayPolicy, isOwnMessage, myDisplayPref);

    if (effectivePolicy === 'anonymous') {
      const idx = getOrAssignAttendeeIndex(senderDid, senderIndexMap.current, nextIndex);
      return `Attendee #${idx + 1}`;
    }

    const profile = profilesRef.current[senderDid];

    if (effectivePolicy === 'real_name') {
      return resolveRealNameDisplay(senderDid, profile, names, fetchProfile);
    }

    if (effectivePolicy === 'handle') {
      return resolveHandleDisplay(senderDid, profile, names, fetchProfile);
    }

    return undefined; // Let Chat use default didNames
  }, [nameDisplayPolicy, myDisplayPref, fetchProfile]);

  const handleDisplayPrefChange = useCallback((pref: string) => {
    setMyDisplayPref(pref as 'real_name' | 'handle' | 'anonymous');
    localStorage.setItem(`eventChat_displayPref_${eventId}`, pref);
  }, [eventId]);

  return (
    <Chat
      did={did}
      currentUserDid={currentUserDid ?? undefined}
      compact={compact}
      enterToSend
      enableVoice
      enableMedia
      enableLocation
      showCapabilityGates
      footerText="Visible to all ticket holders"
      nameDisplayPolicy={nameDisplayPolicy}
      displayPrefStorageKey={`eventChat_displayPref_${eventId}`}
      onDisplayPrefChange={handleDisplayPrefChange}
      resolveDisplayName={resolveDisplayName}
      mediaUrl={MEDIA_URL}
    />
  );
}
