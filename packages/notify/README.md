# @imajin/notify

Best-effort notification client. `send`, `broadcast`, and `interest` retain their
existing parameters and `Promise<void>` return values.

## Registered apps

Configure a vault-backed app-service token provider at boot:

```ts
import { configureNotify, notify } from '@imajin/notify';

configureNotify({
  serviceUrl: 'https://jin.imajin.ai/notify',
  // Application-owned callback: return a fresh/cached token using your
  // vault-backed app identity and /auth/api/apps/token/service.
  appTokenProvider: () => appCredentials.getServiceToken(),
});

await notify.send({
  to: 'did:imajin:example-recipient',
  scope: 'example.notification',
  title: 'Example',
});
```

`appCredentials` above is the application's credential manager, not an SDK
export. The callback returns a token string (or `undefined` when unavailable);
it may be asynchronous. A configured app provider never falls back to a more
privileged internal credential.

The registered app must be active and hold the endpoint's scope in both its
token and its current operator-approved service scope list:

- `send`: `notify:send`
- `broadcast`: `notify:broadcast`
- `interest`: `notify:interest`

Use the existing countersigned `apps:service-scopes` approval flow. These scopes
are not self-granted by listing them in the app's requested scopes. User/session
and user-delegated app tokens are rejected.

## Internal services

By default, the client reads the already vault-resolved internal key through
`@imajin/auth`'s `getVaultInternalApiKey()`. Existing kernel/services that call
`provideInternalApiKey` or `bootstrapInternalApiKey` at boot need no call-site
changes. `configureNotify({ internalSecretProvider: () => vaultKey })` can instead
provide an internal credential explicitly; `vaultKey` must come from the vault.
No shared-secret environment variable is read.

The URL still defaults to `NOTIFY_SERVICE_URL`. Missing URLs/credentials skip
delivery; provider/fetch errors and rejected responses are logged without
throwing. The SDK no longer sends legacy notify webhook-header credentials. The kernel
retains a temporary, explicitly configured notify-only dual-accept bridge for
unmigrated userspace callers (documented in the notify operator-approvals contract,
2026-10-14); new integrations must use the provider contract above.
