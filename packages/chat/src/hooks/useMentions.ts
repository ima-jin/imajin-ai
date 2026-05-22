'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

export interface Member {
  did: string;
  role: string;
  name: string;
  handle: string;
}

interface SearchIdentity {
  did: string;
  handle: string | null;
  name: string | null;
  scope: string;
  subtype: string | null;
  avatarUrl: string | null;
  avatarAssetId: string | null;
}

export interface Mention {
  did: string;
  handle: string;
  index: number;
  length: number;
}

export interface MentionResult {
  did: string;
  handle: string;
  name: string;
  role?: string;
  avatarUrl?: string | null;
  avatarAssetId?: string | null;
}

interface UseMentionsOptions {
  text: string;
  setText: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  members: Member[];
  isGroup: boolean;
  authUrl: string;
}

interface UseMentionsReturn {
  isOpen: boolean;
  query: string;
  results: MentionResult[];
  highlightedIndex: number;
  selectMention: (result: MentionResult) => void;
  closePicker: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  mentions: Mention[];
}

function detectMentionContext(
  text: string,
  cursorPos: number
): { query: string; startIndex: number } | null {
  let i = cursorPos - 1;
  while (i >= 0 && text[i] !== ' ' && text[i] !== '\n') {
    if (text[i] === '@') {
      if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n') {
        return { query: text.slice(i + 1, cursorPos), startIndex: i };
      }
      return null;
    }
    i--;
  }
  return null;
}

export function useMentions({
  text,
  setText,
  textareaRef,
  members,
  isGroup,
  authUrl,
}: UseMentionsOptions): UseMentionsReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null);
  const [globalResults, setGlobalResults] = useState<SearchIdentity[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOpenRef = useRef(isOpen);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  const detectMention = useCallback((value: string, cursorPos: number) => {
    const ctx = detectMentionContext(value, cursorPos);
    if (ctx) {
      setQuery(ctx.query);
      setMentionStartIndex(ctx.startIndex);
      setIsOpen(true);
      setHighlightedIndex(0);
    } else {
      setIsOpen(false);
      setQuery('');
      setMentionStartIndex(null);
      setGlobalResults([]);
    }
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      detectMention(e.target.value, e.target.selectionStart);
    },
    [detectMention]
  );

  const localResults = useMemo(() => {
    const q = query.toLowerCase();
    return members.filter(
      (m) =>
        m.handle.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [members, query]);

  // Debounced global search when local matches are sparse
  useEffect(() => {
    if (!isOpen || query.length < 1) {
      setGlobalResults([]);
      return;
    }

    if (localResults.length >= 3) {
      setGlobalResults([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `${authUrl}/api/search?q=${encodeURIComponent(query)}&limit=5`,
          { credentials: 'include' }
        );
        if (res.ok) {
          const data = await res.json();
          const existingDids = new Set(members.map((m) => m.did));
          const filtered = (data.results as SearchIdentity[]).filter(
            (r) => !existingDids.has(r.did) && r.handle
          );
          setGlobalResults(filtered);
        }
      } catch {
        setGlobalResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isOpen, query, localResults.length, members, authUrl]);

  const results = useMemo(() => {
    const out: MentionResult[] = [];
    const q = query.toLowerCase();

    // @everyone as first option for group conversations
    if (isGroup && (q.length === 0 || 'everyone'.includes(q))) {
      out.push({
        did: '__everyone__',
        handle: 'everyone',
        name: 'Everyone',
        role: 'broadcast',
      });
    }

    // Local members
    for (const m of localResults) {
      out.push({
        did: m.did,
        handle: m.handle,
        name: m.name,
        role: m.role,
      });
    }

    // Global search results
    for (const r of globalResults) {
      if (r.handle) {
        out.push({
          did: r.did,
          handle: r.handle,
          name: r.name ?? r.handle,
          avatarUrl: r.avatarUrl,
          avatarAssetId: r.avatarAssetId,
        });
      }
    }

    return out;
  }, [isGroup, query, localResults, globalResults]);

  const selectMention = useCallback(
    (result: MentionResult) => {
      if (mentionStartIndex === null) return;
      const cursorPos = textareaRef.current?.selectionStart ?? text.length;
      const before = text.slice(0, mentionStartIndex);
      const after = text.slice(cursorPos);
      const newText = `${before}@${result.handle} ${after}`;
      setText(newText);
      setIsOpen(false);
      setQuery('');
      setMentionStartIndex(null);
      setGlobalResults([]);

      // Restore cursor after inserted mention
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          const newPos = mentionStartIndex + result.handle.length + 2;
          el.selectionStart = newPos;
          el.selectionEnd = newPos;
          el.focus();
        }
      }, 0);
    },
    [text, mentionStartIndex, setText, textareaRef]
  );

  const closePicker = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setMentionStartIndex(null);
    setGlobalResults([]);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!isOpenRef.current) return false;
      const count = results.length;
      if (count === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % count);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => (i - 1 + count) % count);
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const selected = results[highlightedIndex];
        if (selected) selectMention(selected);
        return true;
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
        return true;
      }
      return false;
    },
    [results, highlightedIndex, selectMention]
  );

  // Scan text for @mentions to build the mentions array
  const mentions = useMemo(() => {
    const out: Mention[] = [];
    const regex = /@(\w+)/g;
    let match: RegExpExecArray | null;
    const handleToDid = new Map<string, string>();
    for (const m of members) {
      handleToDid.set(m.handle, m.did);
    }
    while ((match = regex.exec(text)) !== null) {
      const handle = match[1];
      const did = handleToDid.get(handle);
      if (did) {
        out.push({
          did,
          handle,
          index: match.index,
          length: match[0].length,
        });
      } else if (handle === 'everyone' && isGroup) {
        out.push({
          did: '__everyone__',
          handle: 'everyone',
          index: match.index,
          length: match[0].length,
        });
      }
    }
    return out;
  }, [text, members, isGroup]);

  return {
    isOpen,
    query,
    results,
    highlightedIndex,
    selectMention,
    closePicker,
    handleKeyDown,
    handleChange,
    mentions,
  };
}
