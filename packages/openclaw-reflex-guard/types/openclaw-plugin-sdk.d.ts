/**
 * Minimal ambient type shim for the `openclaw` plugin SDK.
 *
 * This package peer-depends on the `openclaw` host at runtime (see README)
 * but does not install it as a devDependency here — the same posture as the
 * sibling `@openclaw/imajin-plugin` package (`openclaw-imajin-plugin/index.ts`
 * in this org, imports the same module with no local `openclaw` dependency).
 * `tsc --noEmit` needs *some* declaration for `openclaw/plugin-sdk/plugin-entry`
 * to resolve the import in `index.ts`; this shim provides just enough shape
 * for that check without vendoring the full (much larger, semver-unstable)
 * host SDK types.
 *
 * `PluginApi` is intentionally loose — the real host object documented in
 * `docs/plugins/hooks.md` is far richer than this. Handlers in `src/` accept
 * precisely-typed events/results of their own (see
 * `src/outbound-guard-hooks.ts` and `src/reflex-finalize-hook.ts`); only the
 * `api.on(...)` call site itself needs to satisfy this shim.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginApi {
    pluginConfig: unknown;
    // Deliberately permissive: this shim accepts every differently-typed
    // handler this package registers (see module doc above); a stricter
    // parameter type here would reject the precisely-typed handlers built
    // in src/*.
    on(
      hookName: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (event: any, ctx?: any) => unknown,
      options?: Record<string, unknown>,
    ): void;
    registerTool?(tool: unknown): void;
    registerService?(service: unknown): void;
    [key: string]: unknown;
  }

  export interface PluginEntryDefinition {
    id: string;
    name: string;
    description?: string;
    register(api: PluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntryDefinition): PluginEntryDefinition;
}
