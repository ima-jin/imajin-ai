import React from 'react';
import ReactMarkdown from 'react-markdown';

export interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="prose dark:prose-invert max-w-none">
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl font-mono font-bold mb-4 text-primary">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-mono font-bold mb-3 text-primary">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-mono font-semibold mb-2 text-primary">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="mb-4 leading-relaxed text-secondary">{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-imajin-purple hover:text-imajin-blue underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside mb-4 space-y-1 text-secondary">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside mb-4 space-y-1 text-secondary">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-secondary">{children}</li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-imajin-purple pl-4 my-4 italic text-muted">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => (
            <strong className="font-bold text-primary">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-secondary">{children}</em>
          ),
          code: ({ children }) => (
            <code className="bg-surface-elevated px-1 py-0.5 text-sm font-mono text-imajin-orange">
              {children}
            </code>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
