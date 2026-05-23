'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Chat } from '@imajin/chat';
import { apiFetch } from '@imajin/config';
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

export function EventChatWrapper({ did, eventId, compact }: Readonly<EventChatWrapperProps>) {
  const [nameDisplayPolicy, setNameDisplayPolicy] = useState<NameDisplayPolicy>('attendee_choice');
  const [myDisplayPref, setMyDisplayPref] = useState<'real_name' | 'handle' | 'anonymous'>('handle');
  const [currentUserDid, setCurrentUserDid] = useState<string | null>(null);
  const profilesRef = useRef<Record<string, Profile>>({});
  const senderIndexMap = useRef<Map<string, number>>(new Map());
  const nextIndex = useRef(0);
  const fetchingRef = useRef<Set<string>>(new Set());

  const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3002';

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
      setMyDisplayPref(stored);
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
      if (!senderIndexMap.current.has(senderDid)) {
        senderIndexMap.current.set(senderDid, nextIndex.current);
        nextIndex.current += 1;
      }
      const idx = senderIndexMap.current.get(senderDid)!;
      return `Attendee #${idx + 1}`;
    }

    // Determine effective policy for this sender
    let effectivePolicy: 'real_name' | 'handle' | 'anonymous';
    if (nameDisplayPolicy === 'attendee_choice') {
      effectivePolicy = isOwnMessage ? myDisplayPref : 'handle';
    } else {
      effectivePolicy = nameDisplayPolicy as 'real_name' | 'handle' | 'anonymous';
    }

    if (effectivePolicy === 'anonymous') {
      if (!senderIndexMap.current.has(senderDid)) {
        senderIndexMap.current.set(senderDid, nextIndex.current);
        nextIndex.current += 1;
      }
      const idx = senderIndexMap.current.get(senderDid)!;
      return `Attendee #${idx + 1}`;
    }

    const profile = profilesRef.current[senderDid];

    if (effectivePolicy === 'real_name') {
      if (profile?.name) return profile.name;
      if (names[senderDid]) return names[senderDid]; // useChatNames may already have the name
      if (profile?.handle) return `@${profile.handle}`;
      // Trigger lazy fetch and fallback
      fetchProfile(senderDid);
      return senderDid.slice(0, 16) + '...';
    }

    if (effectivePolicy === 'handle') {
      if (profile?.handle) return `@${profile.handle}`;
      // If we only have a name in didNames but want handle, try to fetch
      fetchProfile(senderDid);
      if (names[senderDid]?.startsWith('@')) return names[senderDid];
      return senderDid.slice(0, 16) + '...';
    }

    return undefined; // Let Chat use default didNames
  }, [nameDisplayPolicy, myDisplayPref, fetchProfile]);

  const handleDisplayPrefChange = useCallback((pref: string) => {
    setMyDisplayPref(pref);
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
