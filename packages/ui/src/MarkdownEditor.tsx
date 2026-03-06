'use client';

import React from 'react';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  linkPlugin,
  linkDialogPlugin,
  toolbarPlugin,
  markdownShortcutPlugin,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  CreateLink,
  ListsToggle,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
}

export function MarkdownEditor({ value, onChange, placeholder, maxLength }: MarkdownEditorProps) {
  const handleChange = (md: string) => {
    if (maxLength !== undefined && md.length > maxLength) return;
    onChange(md);
  };

  return (
    <div
      className="rounded-lg border border-gray-600 overflow-hidden"
      style={
        {
          '--baseBg': '#1a1a1a',
          '--basePageBg': '#1a1a1a',
          '--baseTextContrast': '#e5e7eb',
          '--baseText': '#d1d5db',
          '--baseBorder': '#374151',
          '--accentBase': '#f97316',
          '--accentBgHover': 'rgba(249,115,22,0.15)',
          '--accentTextContrast': '#f97316',
        } as React.CSSProperties
      }
    >
      <MDXEditor
        markdown={value}
        onChange={handleChange}
        placeholder={placeholder}
        className="dark-theme dark-editor"
        plugins={[
          headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
          listsPlugin(),
          quotePlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <BlockTypeSelect />
                <Separator />
                <BoldItalicUnderlineToggles options={['Bold', 'Italic']} />
                <Separator />
                <CreateLink />
                <Separator />
                <ListsToggle />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}
