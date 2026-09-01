/**
 * Stub `InjectionChecker` (issue #1252 Layer 2 scope: "the LLM-judgment step
 * behind an interface stubbed for a follow-up"). Always reports no concerns
 * tripped — a safe, inert default so an operator who flips
 * `reflex.enabled: true` before the real judgment step ships never gets
 * spurious `<beta>` stamps or amend passes out of an unimplemented check.
 *
 * Replace via `ReflexFinalizeHookOptions.injectionChecker`
 * (`src/reflex-finalize-hook.ts`) once the real concern-list judgment call —
 * seeded from SOUL.md/MEMORY.md doctrines per the issue, and trained against
 * live `reflex-log.jsonl` fires once the warrant gate is generating them
 * again — is built.
 */
import type { ConcernFinding, InjectionChecker, ReflexTurnContext, WarrantTrigger } from "./reflex-types.js";

export function createStubInjectionChecker(): InjectionChecker {
  return {
    async checkConcerns(_turn: ReflexTurnContext, _triggers: WarrantTrigger[]): Promise<ConcernFinding[]> {
      // No concerns are ever tripped by the stub — see module doc above.
      return [];
    },
  };
}
