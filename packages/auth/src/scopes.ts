/**
 * Scope vocabulary for delegated app sessions (Issue #244).
 *
 * DERIVED — do not hand-edit the scope list here.
 *
 * `SCOPES` is now a projection of `SCOPE_VOCABULARY` in ./scope-vocabulary.ts
 * (#1253). To add, remove, or relabel a scope, edit that table: this map, the
 * MCP OAuth capability ceiling, every connector's scope-manifest descriptors,
 * and the connector-card UI list all fall out of it automatically.
 *
 * Key order follows vocabulary order, which is what the consent screens
 * (/auth/authorize, /auth/apps) and the app-registration forms render in.
 */
import { SCOPES, type Scope } from './scope-vocabulary';

export type { Scope };
export { SCOPES };

export function validateScopes(scopes: string[]): { valid: Scope[]; invalid: string[] } {
  const valid: Scope[] = [];
  const invalid: string[] = [];
  for (const s of scopes) {
    if (s in SCOPES) valid.push(s as Scope);
    else invalid.push(s);
  }
  return { valid, invalid };
}
