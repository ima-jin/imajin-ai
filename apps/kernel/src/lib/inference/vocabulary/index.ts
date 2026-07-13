/**
 * Vocabulary registry (v1 — static import map).
 *
 * Maps stable vocabulary name strings → IntentVocabulary instances. The
 * capture API route and MCP tools select a vocabulary by name from this map.
 * No dynamic registry needed in v1; add new tenants here as a line.
 */

import { imajinVocabulary } from './imajin';
import { agrifortressVocabulary } from './agrifortress';
import type { IntentVocabulary } from './contract';

const VOCABULARIES = new Map<string, IntentVocabulary>([
  ['imajin', imajinVocabulary],
  ['agrifortress', agrifortressVocabulary],
]);

export function getVocabulary(name: string): IntentVocabulary | undefined {
  return VOCABULARIES.get(name);
}

export function listVocabularyNames(): string[] {
  return [...VOCABULARIES.keys()];
}

export { imajinVocabulary, agrifortressVocabulary };
export type { IntentVocabulary };
