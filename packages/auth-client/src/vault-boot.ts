import { loadFromVault, type AppVaultCredentials, type LoadFromVaultOptions } from './load-from-vault';

export interface VaultBootOptions<Config extends object> {
  vault: LoadFromVaultOptions;
  /** Map credentials into the app's server-only configuration. Never log or persist them. */
  configure: (credentials: AppVaultCredentials) => Config | Promise<Config>;
}

export interface VaultBoot<Config extends object> {
  /** Available only after credential loading/configuration, including during delayed module imports. */
  getConfig: () => Readonly<Config>;
  /** Invoke once, with a callback that dynamically imports and starts the server. */
  start: <Result>(callback: (config: Readonly<Config>) => Result | Promise<Result>) => Promise<Result>;
}

/**
 * Establishes an explicit pre-import boot boundary without writing process.env.
 * Keep this instance in a server-only config module; import application/DB modules
 * dynamically inside start's callback, never statically from the entrypoint.
 */
export function createVaultBoot<Config extends object>(options: VaultBootOptions<Config>): VaultBoot<Config> {
  let config: Readonly<Config> | undefined;
  let started = false;
  return {
    getConfig() {
      if (!config) throw new Error('vault boot: configuration unavailable');
      return config;
    },
    async start(callback) {
      if (started) throw new Error('vault boot: already started');
      started = true;
      try {
        const credentials = await loadFromVault(options.vault);
        config = Object.freeze(await options.configure(credentials));
        return await callback(config);
      } catch {
        config = undefined;
        // No provider errors or causes: configuration/start callbacks can contain secrets too.
        throw new Error('vault boot: startup failed');
      }
    },
  };
}
