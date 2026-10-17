# App-declared self-secrets
Declare recipes in the registered app's root `imajin.app.json`. Recipes contain names and kinds only, never values:
```json
{
  "secrets": [
    { "name": "SESSION_SECRET", "kind": "random-32B" },
    { "name": "DATABASE_URL", "kind": "operator-supplied" }
  ]
}
```
Names are unique uppercase identifiers (at most 64 characters). For `random-32B` and `random-64B`, the kernel generates that many CSPRNG bytes, hex-encodes them, and seals them using existing internal-secret vault custody. `operator-supplied` declares an arbitrary operator-provided string, such as an existing database connection string or provider password; no value or default belongs in the manifest. There are at most 32 declarations. Extra properties, duplicate names and unknown kinds are refused without reflecting their values.
An operator-supplied declaration is not a generated credential. Provision/claim and manifest sync register its name and kind but do not invent a value. Missing material stays unavailable until the operator supplies it and countersigns the pending set proposal. A staged input is not an active app grant.
## Boot
After the app's existing claim flow has established its local bootstrap keystore, call the server-only helper:
```ts
import { loadFromVault } from '@ima-jin/auth-client';

const credentials = await loadFromVault({
  keys: [{ key: 'SESSION_SECRET', onMissing: 'fail' }],
});
// Pass credentials.values.SESSION_SECRET directly to the in-memory session signer.
// Never print, persist, expose, or assign it to process.env.
```
The helper resolves the app DID, kernel URL and keystore path from the same non-secret configuration as `loadAppSigningKey`. It signs a domain-separated request with the bound keystore, discovers the current grant through the kernel, and opens an encrypted response only in memory. It needs no grant ID, bearer, session secret, bootstrap token or secret-generation command in an env file. Public ingress must enforce TLS; the SDK requires HTTPS except for literal loopback testing and refuses redirects.
Use `onMissing: 'fail'` for a load-bearing secret. An optional `'degrade'` key is omitted and listed in `degraded`; a required key still fails even if other keys are optional. This thin app client is distinct from the generic `@imajin/auth` grant loader: that existing API and its deferred acknowledgement contract remain unchanged.
## Pre-import boot boundary for database consumers
Awaiting `loadFromVault` in an instrumentation hook is insufficient if a static import has already initialized a DB client from `process.env.DATABASE_URL`. The supported choice is **typed server-only in-memory configuration**, not copying fetched values into `process.env`.
Create one config module that imports no server/DB modules:
```ts
// src/server-config.ts
import { createVaultBoot } from '@ima-jin/auth-client';

interface ServerConfig {
  DATABASE_URL: string;
  SESSION_SECRET: string;
}

export const boot = createVaultBoot<ServerConfig>({
  vault: {
    keys: [
      { key: 'DATABASE_URL', onMissing: 'fail' },
      { key: 'SESSION_SECRET', onMissing: 'fail' },
    ],
  },
  configure: ({ values }) => ({
    DATABASE_URL: values.DATABASE_URL,
    SESSION_SECRET: values.SESSION_SECRET,
  }),
});
```
Use a dedicated server entrypoint to finish the existing claim/bootstrap flow, load credentials, and only then import the application:
```ts
// src/boot.ts — no static import of ./server or any module that imports ./db
import { loadAppSigningKey } from '@ima-jin/auth-client';
import { boot } from './server-config';

async function main() {
  const signingKey = await loadAppSigningKey();
  await boot.start(async (config) => {
    const { start } = await import('./server');
    await start({ config, signingKey });
  });
}

void main().catch(() => {
  // Fixed diagnostic only; never print the original exception or config.
  console.error('App startup failed');
  process.exitCode = 1;
});
```
Refactor module-load consumers to use the shared accessor:
```ts
// src/db.ts — evaluated only through the delayed ./server import
import postgres from 'postgres';
import { boot } from './server-config';

export const db = postgres(boot.getConfig().DATABASE_URL);
```
Session signers and other consumers likewise receive `config.SESSION_SECRET`, not an env fallback. The config exists before the start callback runs, including during dynamic module evaluation. `configure` may be async; the helper awaits it too. `getConfig()` fails before initialization or after a failed start. Configuration is shallow-frozen, and `start()` is one-shot: repeated/concurrent attempts fail, including after failure. Restart the process to retry. All load/configure/start failures become a fixed error without a provider message or cause.
The helper does not start a framework, establish the claim keystore, migrate an app, or defeat ESM static-import ordering. An app must refactor its entrypoint/import graph and all env-reading consumers; merely adding the helper beside an eager DB import is not adoption. For frameworks that initialize modules during builds, separate build-time tooling from runtime boot and avoid initializing a DB client during build. No process-global env bridge or plaintext config file is needed.
Regression: `pnpm exec vitest run packages/auth-client/tests/vault-boot.test.ts` demonstrates a DB fixture capturing `DATABASE_URL` at module initialization only after vault resolution, with `process.env.DATABASE_URL` unset. Fixtures are deliberately fake and never connect to a database.
## Provision, re-sync and rotation
Fresh provisioning previews the template manifest before a repo exists, and re-checks the copied manifest against the operator's signed approval before registering it. Provision and claim issue missing generated declarations through the existing kernel custody path; operator-supplied declarations await input. For an already-claimed app, the operator selects **Sync manifest secrets** on `/jin` and signs the proposed recipes. Re-sync never widens scope or event permissions and never replaces existing values. A recipe kind cannot be changed by re-sync.
An app can fetch only active names registered for its own DID. It cannot choose a foreign purpose or grant ID, and generic plaintext grant-fetch HTTP refuses app self-secret fields. The new HTTP response contains ciphertext only; operator cards, attestations, errors and logs contain metadata only.
For generated kinds, **Rotate** on `/jin` generates and seals a replacement. For `operator-supplied`, **Set** supplies missing/revoked material and **Rotate** supplies a replacement for active material using a masked input. Values are sealed in staging, not included in the approval payload, and become fetchable only after verified human countersign execution. Proposing a rotation leaves the old active value unchanged. Rotation reissues the same consumers and crypto-erases superseded grants using existing custody machinery. The next boot fetches the new generation without any file edit. Rotating `SESSION_SECRET` signs users out after restart. **Revoke** withdraws future fetches; re-sync does not resurrect it, and values already held by a running process are not remotely erased.
The initial custody path is Tier 0 (kernel-owned internal secret with an app-DID grant). Tier 1 is refused rather than leaving half-issued app secrets. Existing vault-file/DB rotation failure semantics are inherited from the internal-secret machinery.
## Adoption order (follow-up work, not an automatic cutover)
Each app/environment needs its own reviewed manifest, import-graph/config refactor, operator set approval, and coordinated restart. Declare and countersign first, verify boot readiness without printing values, then remove the old hand-provisioned value only through that app's reviewed adoption. Do not silently fall back to an env secret when a required vault fetch fails.
1. **Database-first:** events, coffee, learn, market and links — `DATABASE_URL`. These are the priority regression targets because DB modules commonly read it during import.
2. **Additional app credentials:** events — `WEBHOOK_SECRET`, `SMTP_PASSWORD`; fixready, karaoke and scorecard — `SESSION_SECRET`; xprize — `APP_PRIVATE_KEY`, `SESSION_SECRET`, `PAY_SERVICE_API_KEY`; dykil — `LEGACY_DATABASE_URL`.
3. **Development inventory:** coffee, learn and market — `SESSION_SECRET`; learn and market — `WEBHOOK_SECRET`. **Omit coffee `WEBHOOK_SECRET`: it is vestigial, not an adoption target.**
The xprize pay-key entry records a legacy consumer to investigate, not permission to revive the kernel's retired shared pay key. Current scoped pay callers use app-service tokens (see [Environment Configuration](ENVIRONMENTS.md#scoped-pay-callers-2735)); resolve the actual consumer in its standalone follow-up before declaring/importing a credential.
Use `operator-supplied` for externally assigned/existing strings; a fresh app-owned random session secret can remain a generated kind when session invalidation is acceptable. Importing an existing session secret preserves its bytes; generating or rotating it intentionally invalidates sessions after restart.
No standalone repository, environment file, host, deploy configuration or running app is changed by this feature. Per-app adoption and #2260 remain separate work. SDK versions remain release-managed in lockstep; feature PRs never edit package versions or promise a hand-picked release number. Consume the SDK release containing this helper through the normal reviewed Release workflow after merge.
