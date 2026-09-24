/**
 * Local decision-card organizer (#2315).
 *
 * Produces the session-start brief from the open DecisionCard pile:
 * clusters by subject/blocker graph, ranks by p-label · blocks-count ·
 * age · CI state · authority, one line per card, and flags stale cards.
 *
 * HARD RULE: this module reads CARDS ONLY. No GitHub reads, no network
 * call to resolve a fact a card is missing — if a ranking needs a fact a
 * card lacks, the fix is to add the field to `./schema.ts`, never to fetch
 * it here. `clusterCards` (via `organizeCards`) is therefore a PURE
 * function over `DecisionCard[]`, and doubles as the FALLBACK the brief
 * uses whenever no `provider` is configured — the real endpoint this
 * ships against (ollama on imajin-ml's private LAN) is unreachable from
 * here and from CI, so the deterministic path isn't a degraded mode, it's
 * the one every test in `./__tests__/organize.test.ts` actually exercises.
 */
import { createLogger } from '@imajin/logger';
import type { DecisionCard, DecisionCardPriority } from './schema';

const log = createLogger('kernel:decisions:organize');

export const DEFAULT_ORGANIZER_MODEL = 'qwen3:14b';
const ENV_BASE_URL_KEY = 'DECISION_ORGANIZER_BASE_URL';
const ENV_MODEL_KEY = 'DECISION_ORGANIZER_MODEL';

export interface OrganizerChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** An OpenAI-compatible chat adapter — the only shape the organizer needs from a provider. */
export interface OrganizerChatProvider {
  complete(messages: OrganizerChatMessage[]): Promise<string>;
}

const PRIORITY_RANK: Record<DecisionCardPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
/** No p-label at all ranks below every labeled card — absence of a label is never treated as urgency. */
const UNLABELED_PRIORITY_RANK = 4;

const CI_STATE_RANK: Record<string, number> = {
  failure: 0,
  failed: 0,
  action_required: 0,
  timed_out: 0,
  cancelled: 1,
  pending: 2,
  in_progress: 2,
  neutral: 3,
  success: 4,
};
/** No CI evidence, or a conclusion string we don't recognize, ranks alongside 'neutral' — neither urgent nor settled. */
const UNKNOWN_CI_RANK = 3;

/** A card is "stale" once it's sat this long — long enough that any card at this age is worth flagging, never so short that daily churn floods the brief. */
export const STALE_AGE_MS = 48 * 60 * 60 * 1000;

/** Bare `#<number>` or `<number>` refs — the convention `subject.ref`/blocker numbers are matched under for clustering. */
const NUMERIC_REF_PATTERN = /^#?(\d+)$/;

export interface RankedCard {
  card: DecisionCard;
  ageMs: number;
  stale: boolean;
  blocksCount: number;
}

export interface DecisionCardCluster {
  key: string;
  cards: RankedCard[];
}

function priorityRank(card: DecisionCard): number {
  return card.priority ? PRIORITY_RANK[card.priority] : UNLABELED_PRIORITY_RANK;
}

function ciStateRank(card: DecisionCard): number {
  const conclusion = card.evidence.ci?.conclusion;
  if (!conclusion) return UNKNOWN_CI_RANK;
  return CI_STATE_RANK[conclusion] ?? UNKNOWN_CI_RANK;
}

function blocksCount(card: DecisionCard): number {
  return card.evidence.blockers?.blocks.length ?? 0;
}

/**
 * A card whose evidence already says the standing rules let it proceed
 * without a human is lower urgency for a HUMAN's session brief than one
 * that genuinely needs the human — surfacing human-required cards first is
 * the entire point of this brief.
 */
function authorityRank(card: DecisionCard): number {
  return card.evidence.authority.canActWithoutHuman ? 1 : 0;
}

function ageMs(card: DecisionCard, now: number): number {
  const created = Date.parse(card.createdAt);
  return Number.isNaN(created) ? 0 : Math.max(0, now - created);
}

function subjectKey(card: DecisionCard): string {
  return `${card.subject.kind}:${card.subject.ref}`;
}

/** The bare-numeric alias a card's subject and any blocker refs resolve to, e.g. `ref:#123` — the join key the union-find below clusters on. */
function numericRefAlias(ref: string): string | null {
  const match = NUMERIC_REF_PATTERN.exec(ref.trim());
  return match ? `ref:#${match[1]}` : null;
}

/** Every alias key a card's own subject or its blocker graph references. */
function relatedAliasKeys(card: DecisionCard): string[] {
  const keys: string[] = [];
  const ownAlias = numericRefAlias(card.subject.ref);
  if (ownAlias) keys.push(ownAlias);
  const blockers = card.evidence.blockers;
  if (blockers) {
    for (const ref of [...blockers.blockedBy, ...blockers.blocks]) {
      keys.push(`ref:#${ref.number}`);
    }
  }
  return keys;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  private ensure(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    this.ensure(key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    this.parent.set(key, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

function compareRankedCards(a: RankedCard, b: RankedCard): number {
  const byPriority = priorityRank(a.card) - priorityRank(b.card);
  if (byPriority !== 0) return byPriority;
  const byBlocks = b.blocksCount - a.blocksCount;
  if (byBlocks !== 0) return byBlocks;
  const byAge = b.ageMs - a.ageMs;
  if (byAge !== 0) return byAge;
  const byCi = ciStateRank(a.card) - ciStateRank(b.card);
  if (byCi !== 0) return byCi;
  return authorityRank(a.card) - authorityRank(b.card);
}

/**
 * Union-find over subject/blocker keys — cards sharing a subject, or
 * referencing each other via `evidence.blockers`, land in the same cluster
 * (#2315: "clusters by subject/blocker graph"). Pure over `cards`; `now` is
 * threaded through explicitly (rather than read from `Date.now()` inside)
 * so age/staleness is deterministic for a given call.
 */
export function clusterCards(cards: DecisionCard[], now: number): DecisionCardCluster[] {
  const unionFind = new UnionFind();

  for (const card of cards) {
    const key = subjectKey(card);
    for (const alias of relatedAliasKeys(card)) {
      unionFind.union(key, alias);
    }
  }

  const clustersByRoot = new Map<string, RankedCard[]>();
  for (const card of cards) {
    const root = unionFind.find(subjectKey(card));
    const age = ageMs(card, now);
    const entry: RankedCard = { card, ageMs: age, stale: age >= STALE_AGE_MS, blocksCount: blocksCount(card) };
    const bucket = clustersByRoot.get(root) ?? [];
    bucket.push(entry);
    clustersByRoot.set(root, bucket);
  }

  const clusters: DecisionCardCluster[] = Array.from(clustersByRoot.entries()).map(([root, entries]) => ({
    key: root,
    cards: [...entries].sort(compareRankedCards),
  }));

  clusters.sort((a, b) => compareRankedCards(a.cards[0], b.cards[0]));
  return clusters;
}

function fmtAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return '<1h';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** One line per card — the deterministic (no-model) render (#2315 acceptance: "one line each"). */
function renderBriefLine(entry: RankedCard, index: number): string {
  const { card } = entry;
  const priority = card.priority ? `[${card.priority}]` : '[?]';
  const ci = card.evidence.ci?.conclusion ?? '?';
  const stale = entry.stale ? ' STALE' : '';
  return `${index + 1}. ${priority} ${subjectKey(card)} — ${card.question} (blocks:${entry.blocksCount} ci:${ci} age:${fmtAge(entry.ageMs)}${stale})`;
}

/**
 * Deterministic (no model) brief text — the FALLBACK render `organizeCards`
 * uses directly whenever no `provider` is configured or the provider call
 * fails (#2315 HARD RULE: a pure function, cards only).
 */
export function formatDeterministicBrief(clusters: DecisionCardCluster[]): string {
  if (clusters.length === 0) return 'No open decision cards.';
  const lines: string[] = [];
  let cardIndex = 0;
  for (const cluster of clusters) {
    lines.push(`Cluster ${cluster.key} (${cluster.cards.length}):`);
    for (const entry of cluster.cards) {
      lines.push(`  ${renderBriefLine(entry, cardIndex)}`);
      cardIndex += 1;
    }
  }
  return lines.join('\n');
}

function buildProviderPrompt(clusters: DecisionCardCluster[]): OrganizerChatMessage[] {
  const deterministicBrief = formatDeterministicBrief(clusters);
  return [
    {
      role: 'system',
      content:
        'You turn a pre-ranked, pre-clustered list of decision cards into a short, readable session-start brief. ' +
        'You are given ONLY the ranked/clustered summary below — never assume or fetch any fact not present in it. ' +
        'Keep the existing ranking and clustering; only improve the prose, one line per card.',
    },
    { role: 'user', content: deterministicBrief },
  ];
}

export interface OrganizeCardsResult {
  brief: string;
  clusters: DecisionCardCluster[];
  staleCount: number;
  usedProvider: boolean;
}

/**
 * Organize the open DecisionCard pile into the session-start brief (#2315).
 *
 * Deterministic clustering/ranking always runs first — over `cards` only,
 * per the HARD RULE — and is the sole source of truth for cluster/rank
 * order. When `provider` is supplied, it's asked to reword the
 * already-deterministic brief (never to re-rank); if it's absent, empty,
 * or it throws, `formatDeterministicBrief`'s own render is used as-is —
 * which is what makes the 20-card/under-30s/no-network acceptance hold
 * regardless of whether a provider is configured.
 */
export async function organizeCards(cards: DecisionCard[], provider?: OrganizerChatProvider): Promise<OrganizeCardsResult> {
  const now = Date.now();
  const clusters = clusterCards(cards, now);
  const staleCount = clusters.reduce((count, cluster) => count + cluster.cards.filter((entry) => entry.stale).length, 0);
  const deterministicBrief = formatDeterministicBrief(clusters);

  if (!provider) {
    return { brief: deterministicBrief, clusters, staleCount, usedProvider: false };
  }

  try {
    const brief = await provider.complete(buildProviderPrompt(clusters));
    if (!brief || brief.trim().length === 0) {
      return { brief: deterministicBrief, clusters, staleCount, usedProvider: false };
    }
    return { brief, clusters, staleCount, usedProvider: true };
  } catch (err) {
    log.warn({ err: String(err) }, 'Decision-card organizer provider failed — falling back to the deterministic brief');
    return { brief: deterministicBrief, clusters, staleCount, usedProvider: false };
  }
}

/**
 * Env-configured OpenAI-compatible provider (#2315: "base URL + model;
 * default model qwen3:14b"). Returns undefined when no base URL is
 * configured, which is the case in this environment and in CI — the real
 * endpoint (ollama on imajin-ml's private LAN) is unreachable from both, so
 * `organizeCards`'s deterministic fallback is what actually runs. Uses a
 * dynamic import so nothing that only exercises the fallback path (i.e.
 * every test in `./__tests__/`) pulls in `@imajin/llm`/`ai` at all.
 */
export function createEnvChatProvider(env: NodeJS.ProcessEnv = process.env): OrganizerChatProvider | undefined {
  const baseURL = env[ENV_BASE_URL_KEY];
  if (!baseURL) return undefined;
  const model = env[ENV_MODEL_KEY] ?? DEFAULT_ORGANIZER_MODEL;

  return {
    async complete(messages: OrganizerChatMessage[]): Promise<string> {
      const { getModel } = await import('@imajin/llm');
      const { generateText } = await import('ai');
      const languageModel = getModel('ollama', model, { baseURL });
      const { text } = await generateText({ model: languageModel, messages });
      return text;
    },
  };
}
