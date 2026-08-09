export type SourceType =
  | 'github'
  | 'gitlab'
  | 'gdocs'
  | 'discord'
  | 'slack'
  | 'local'
  | 'email'
  | 'code'
  | (string & {});

export type ThreadState = 'open' | 'closed' | 'merged' | 'archived' | 'draft' | 'unknown';

export type ThreadType = 'issue' | 'pr' | 'discussion' | 'doc' | 'thread' | 'email' | 'code' | (string & {});

export interface ThreadComment {
  author: string;
  authorDid?: string;
  body: string;
  created: string;
  type?: 'comment' | 'review' | 'system' | 'reaction' | (string & {});
  replyTo?: string;
}

export interface ThreadResolution {
  kind: 'fixed' | 'wontfix' | 'duplicate' | 'stale' | 'merged' | 'other';
  note?: string;
  fixedBy?: string;
}

export interface ThreadDocument {
  source: string;
  sourceType: SourceType;
  id: string;
  type: ThreadType;
  title: string;
  state: ThreadState;
  labels: string[];
  author: string;
  authorDid?: string;
  created: string;
  closed?: string;
  updated: string;
  linkedRefs: string[];
  body: string;
  comments: ThreadComment[];
  resolution?: ThreadResolution;
  url?: string;
  meta?: Record<string, unknown>;
}

export interface CorpusSearchRequest {
  query: string;
  sourceType?: SourceType;
  source?: string;
  state?: ThreadState | ThreadState[];
  type?: ThreadType | ThreadType[];
  labels?: string[];
  author?: string;
  limit?: number;
  budget?: number;
}

export interface CorpusSearchHit {
  source: string;
  id: string;
  type: ThreadType;
  title: string;
  state: ThreadState;
  resolution?: ThreadResolution;
  score: number;
  evidence: string[];
  url?: string;
  updated: string;
}

export interface CorpusSourceFreshness {
  source: string;
  lastSync: string;
  threadCount: number;
  warning?: string;
}

export interface CorpusSearchResult {
  results: CorpusSearchHit[];
  totalHits: number;
  freshness: CorpusSourceFreshness[];
  tokensUsed: number;
}

export interface CorpusStatus {
  sources: CorpusSourceFreshness[];
  threadCount: number;
}
