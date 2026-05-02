'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';

/**
 * Lightweight markdown renderer for chat bubbles.
 * 
 * Unlike MarkdownContent in @imajin/ui, this inherits text color from the
 * parent bubble (white for own messages, dark for received) and uses compact
 * spacing appropriate for chat.
 */

const MARKDOWN_HINT = /[*_`#\-\d+\.]\s|^\s*[-*]\s|^\s*\d+\.\s|\[.+\]\(.+\)|^>\s/m;

/** Returns true if the text contains markdown-like syntax worth rendering. */
export function hasMarkdown(text: string): boolean {
  return MARKDOWN_HINT.test(text);
}

export interface ChatMarkdownProps {
  content: string;
  isOwn: boolean;
}

export function ChatMarkdown({ content, isOwn }: ChatMarkdownProps) {
  // Color scheme: own bubbles have white text, received have default dark/light text
  const textColor = isOwn ? 'text-white' : 'text-gray-900 dark:text-gray-100';
  const mutedColor = isOwn ? 'text-white/70' : 'text-gray-500 dark:text-gray-400';
  const linkColor = isOwn
    ? 'text-white underline decoration-white/50 hover:decoration-white'
    : 'text-blue-400 hover:text-blue-300 underline';
  const codeBackground = isOwn
    ? 'bg-white/15'
    : 'bg-gray-100 dark:bg-gray-700';
  const codeForeground = isOwn
    ? 'text-white'
    : 'text-orange-600 dark:text-orange-300';
  const blockquoteBorder = isOwn
    ? 'border-white/40'
    : 'border-orange-500';
  const strongColor = isOwn ? 'text-white' : 'text-gray-900 dark:text-white';
  const mentionColor = 'text-amber-400 font-medium';

  return (
    <div className={`text-sm ${textColor} max-w-none`}>
      <ReactMarkdown
        components={{
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
