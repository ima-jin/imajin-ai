export const DEFAULT_TOKEN_BUDGET = 4000;
export const DEFAULT_SEARCH_LIMIT = 10;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = Math.max(0, tokenBudget * 4);
  if (text.length <= charBudget) {
    return text;
  }

  if (charBudget <= 1) {
    return '';
  }

  return `${text.slice(0, charBudget - 1).trimEnd()}…`;
}
