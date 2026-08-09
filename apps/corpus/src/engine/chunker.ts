import type { ThreadDocument } from './types';

export interface ThreadChunk {
  title: string;
  body: string;
  comments: string;
  searchText: string;
}

export function chunkThread(document: ThreadDocument): ThreadChunk {
  // Thread-aware chunking: the unit is the full thread. Only genuinely
  // content-bearing fields are indexed for full-text relevance — title,
  // body, and comments — per the spec. Structured metadata (source, type,
  // labels, author, resolution) is stored in dedicated columns and used for
  // filtering/boosting instead, so it doesn't pollute BM25 term matching.
  const comments = document.comments.map(comment => comment.body).join('\n\n');
  const searchText = [document.title, document.body, comments].filter(Boolean).join('\n\n');

  return {
    title: document.title,
    body: document.body,
    comments,
    searchText,
  };
}

export function collectEvidenceText(document: ThreadDocument): string {
  const chunk = chunkThread(document);
  return chunk.searchText;
}
