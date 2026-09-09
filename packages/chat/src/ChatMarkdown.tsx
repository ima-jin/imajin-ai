'use client';

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';

/**
 * Lightweight markdown renderer for chat bubbles.
 * 
 * Unlike MarkdownContent in @imajin/ui, this inherits text color from the
 * parent bubble (white for own messages, dark for received) and uses compact
 * spacing appropriate for chat.
 */


/** Returns true if the text contains markdown-like syntax worth rendering. */
export function hasMarkdown(text: string): boolean {
  const hintTokens = ['**', '__', '`', '# ', '\n# ', '\n## ', '\n### ', '\n> ', '[', '](', '\n- ', '\n* '];
  if (hintTokens.some((token) => text.includes(token))) return true;

  const lines = text.split('\n');
  return lines.some((line) => {
    const trimmed = line.trimStart();
    if (!trimmed) return false;
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('> ')) return true;
    const dot = trimmed.indexOf('.');
    if (dot <= 0) return false;
    for (let i = 0; i < dot; i += 1) {
      const code = trimmed.codePointAt(i)!;
      if (code < 48 || code > 57) return false;
    }
    return trimmed[dot + 1] === ' ';
  });
}

export interface ChatMarkdownProps {
  content: string;
  isOwn: boolean;
}

interface ChatMarkdownColors {
  textColor: string;
  mutedColor: string;
  linkColor: string;
  codeBackground: string;
  codeForeground: string;
  blockquoteBorder: string;
  strongColor: string;
}

// Color scheme: own bubbles have white text, received have default dark/light text
function getChatMarkdownColors(isOwn: boolean): ChatMarkdownColors {
  return {
    textColor: isOwn ? 'text-white' : 'text-gray-900 dark:text-gray-100',
    mutedColor: isOwn ? 'text-white/70' : 'text-gray-500 dark:text-gray-400',
    linkColor: isOwn
      ? 'text-white underline decoration-white/50 hover:decoration-white'
      : 'text-blue-400 hover:text-blue-300 underline',
    codeBackground: isOwn ? 'bg-white/15' : 'bg-gray-100 dark:bg-gray-700',
    codeForeground: isOwn ? 'text-white' : 'text-orange-600 dark:text-orange-300',
    blockquoteBorder: isOwn ? 'border-white/40' : 'border-orange-500',
    strongColor: isOwn ? 'text-white' : 'text-gray-900 dark:text-white',
  };
}

// Factory called once per distinct color set (memoized in the component below) so the
// resulting component identities stay stable across renders. Kept at module scope so
// none of these renderers are nested inside the ChatMarkdown component body.
function buildChatMarkdownComponents(colors: ChatMarkdownColors): Components {
  const { mutedColor, linkColor, codeBackground, codeForeground, blockquoteBorder, strongColor } = colors;

  return {
    h1: ({ children }) => (
      <p className={`text-base font-bold mb-1 ${strongColor}`}>{children}</p>
    ),
    h2: ({ children }) => (
      <p className={`text-sm font-bold mb-1 ${strongColor}`}>{children}</p>
    ),
    h3: ({ children }) => (
      <p className={`text-sm font-semibold mb-1 ${strongColor}`}>{children}</p>
    ),
    p: ({ children }) => (
      <p className="mb-2 last:mb-0 leading-relaxed whitespace-pre-wrap">{children}</p>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        className={`${linkColor} break-all`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
    ul: ({ children }) => (
      <ul className="list-disc list-inside mb-2 last:mb-0 space-y-0.5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal list-inside mb-2 last:mb-0 space-y-0.5">{children}</ol>
    ),
    li: ({ children }) => <li>{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className={`border-l-2 ${blockquoteBorder} pl-2 my-1 italic ${mutedColor}`}>
        {children}
      </blockquote>
    ),
    strong: ({ children }) => (
      <strong className={`font-bold ${strongColor}`}>{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    code: ({ children, className }) => {
      // Fenced code blocks get a class like "language-xxx"
      const isBlock = typeof className === 'string' && className.startsWith('language-');
      if (isBlock) {
        return (
          <code className={`block ${codeBackground} p-2 rounded text-xs font-mono ${codeForeground} overflow-x-auto my-1`}>
            {children}
          </code>
        );
      }
      return (
        <code className={`${codeBackground} px-1 py-0.5 rounded text-xs font-mono ${codeForeground}`}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => <pre className="my-1">{children}</pre>,
  };
}

export function ChatMarkdown({ content, isOwn }: Readonly<ChatMarkdownProps>) {
  const colors = useMemo(() => getChatMarkdownColors(isOwn), [isOwn]);
  const components = useMemo(() => buildChatMarkdownComponents(colors), [colors]);

  return (
    <div className={`text-sm ${colors.textColor} max-w-none`}>
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
}
