# App-declared self-secrets
Declare recipes in the registered app's root `imajin.app.json`. Recipes contain names and kinds only, never values:
```json
{
  "secrets": [
    { "name": "SESSION_SECRET", "kind": "random-32B" },
    { "name": "TICKET_QR_SECRET", "kind": "random-32B" }
  ]
}
```
Names are unique uppercase identifiers (at most 64 characters). The initial vocabulary is `random-32B` and `random-64B`; the kernel generates that many CSPRNG bytes, hex-encodes them, and seals them using existing internal-secret vault custody. There are at most 32 declarations. Extra properties, duplicate names and unknown kinds are refused without reflecting their values.
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
## Provision, re-sync and rotation
Fresh provisioning previews the template manifest before a repo exists, and re-checks the copied manifest against the operator's signed approval before registering it. Provision and claim issue missing declarations through the existing kernel custody path. For an already-claimed app, the operator selects **Sync manifest secrets** on `/jin` and signs the proposed recipes. Re-sync never widens scope or event permissions and never replaces existing values. A recipe kind cannot be changed by re-sync.
An app can fetch only active names registered for its own DID. It cannot choose a foreign purpose or grant ID, and generic plaintext grant-fetch HTTP refuses app self-secret fields. The new HTTP response contains ciphertext only; operator cards, attestations, errors and logs contain metadata only.
**Rotate** on `/jin` generates and seals a replacement, reissues the same consumers and crypto-erases superseded grants using the existing internal-secret rotation machinery. The next boot fetches the new generation without any file edit. Rotating `SESSION_SECRET` signs users out after restart. **Revoke** withdraws future fetches; re-sync does not resurrect it, and values already held by a running process are not remotely erased.
The initial custody path is Tier 0 (kernel-owned internal secret with an app-DID grant). Tier 1 is refused rather than leaving half-issued app secrets. Existing vault-file/DB rotation failure semantics are inherited from the internal-secret machinery.
SDK versions remain release-managed in lockstep; publish through the normal reviewed Release workflow after merge. Per-app boot adoption is separate work.
