/** Client-safe proposal vocabulary; these actions never return secret values. */
export const APP_SECRET_ACTIONS = ['sync', 'rotate', 'revoke'] as const;
export type AppSecretAction = typeof APP_SECRET_ACTIONS[number];
export function appSecretsKind(action: AppSecretAction): string {
  return `apps:secrets-${action}`;
}
export function isAppSecretsKind(kind: string): boolean {
  return APP_SECRET_ACTIONS.some((action) => appSecretsKind(action) === kind);
}
