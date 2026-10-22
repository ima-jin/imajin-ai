# Verified domain ownership

Domain ownership has two distinct parties: the DNS **zone owner** and the
**site owner** recorded on the active registered app. Hosting an app does not
make Imajin its owner. A custom domain can have a different zone owner from
its app's site owner.

DNS control cannot be used to claim someone else's app. When the two owners
differ on a custom domain, the app's authoritative registry `entryUrl`,
`callbackUrl` or `homepageUrl` must already advertise that exact hostname.
The kernel checks this site-owner authorization when adding and verifying
the claim and on public/routing/credential reads. Withdrawing the registered
hostname hides the binding immediately and revokes it on recheck.

## Custom domains

An identity owner or active organization owner/admin uses the Domains section
of `/auth/settings`:

1. Add the domain and, optionally, its registered app DID.
2. Publish a DNS TXT record at `_imajin.<domain>` whose entire value is the
   zone owner's DID. Split TXT chunks are joined; substrings do not count.
3. Verify. The kernel signs and persists a `domain.verified` attestation and
   the binding in one transaction.
4. Leave the TXT record in place. The authenticated hourly cron rechecks
   eligible DNS bindings and revokes failed proofs. Removing a domain also
   writes `domain.revoked`; it does not erase its history.

Rechecks become due after 24 hours. Public evidence, verified routing and
credential resolution fail closed after 48 hours without a successful DNS
check, even if the scheduler or revocation signer is unavailable.

The site owner is resolved from the registry, never from caller-supplied
`siteOwner` data. Agent delegates cannot execute ownership-affecting domain
mutations: the shared #2360 policy returns `AGENT_APPROVAL_REQUIRED`. They can
propose the action for the owner to execute.

The management endpoints are under
`/auth/api/identities/:did/domains`; see
`apps/kernel/api-spec/auth.yaml` for the full contract. Public verified
evidence is available at `/auth/api/identities/:did/domains/public` and is
linked from that identity's profile.

## Imajin-issued app hosts

The existing countersigned `POST /api/apps/provision` proposal accepts
`siteOwnerDid` and a direct `imajin.ai` subdomain such as
`dev-gbs.imajin.ai`. New apps default to the approving operator as site owner
and `<slug>.imajin.ai` as host. The proposal displays the owner and host before
approval. Reissuing a signing-key claim cannot transfer ownership.

Issuance uses the unsuspended identity pinned by the existing public
`PLATFORM_DID` configuration, with the expected `imajin` handle, not an arbitrary
node claiming to be Imajin. The pinned DID is the authority; the handle alone
is not. There is no scope or tier gate: the real `@imajin` identity is
`community` / `network` / `preliminary`.
This is an identity reference, not a credential. Bootstrap its signing key through
the vault, with an active reusable `domain.issue` purpose grant to the configured node
DID. The kernel checks the fetched key against the organization's registered
public key before signing. Missing organization identity, missing grant, or a
key mismatch defers domain issuance without failing app provisioning or publishing
unsigned ownership; retry the approved host after setup. No organization key or
domain credential belongs in an environment file.

## Visitor evidence and app-host integration

`GET /.well-known/imajin.json`, resolved using the actual Host header, returns:

```json
{
  "siteOwner": "did:imajin:site-owner",
  "appDid": "did:imajin:registered-app",
  "zoneOwner": "did:imajin:zone-owner",
  "attestation": {}
}
```

The actual `attestation` is the persisted signed canonical record, not the
empty illustrative object above. It includes issuer, subject, context,
payload, issuance time and signature. Visitors can compare it with the
identity's public evidence and verify its canonical signature against the
issuer's public key. Unverified, revoked and grandfathered domains return
404, and responses are not cached.

Resolve the issuer through `/auth/api/identity/:did` (public key) or its
chain-verified `/auth/api/identity/:did/did.json` document where available.
The canonical signed object uses `subject_did`, `type`, `context_id`,
`context_type`, `payload` and `issued_at` (epoch milliseconds), reconstructed
from the attestation's camel-case fields and ISO `issuedAt`. Use
`canonicalize` and Ed25519 verification from the auth library. Also compare
the domain, app and both owners with the current public evidence endpoint;
a valid historical signature alone does not establish a currently active
binding.

When an edge routes a standalone app host directly to that app, route the
exact `/.well-known/imajin.json` path to the kernel **with the original Host
preserved** before the app's catch-all upstream. The rest of the app remains
at its own upstream. This is the kernel's contract for #2895; this change does
not alter a running Caddy/Cloudflare deployment.

The `imajin-app-template` follow-up is separate: consume this contract and
render an “Owned by” profile link only for a verified response, naming the
site owner rather than the zone owner. Never substitute an arbitrary typed
footer for verified evidence. That repository is not changed here.

## Routing compatibility

`/api/domain-check?domain=...` is the on-demand TLS authorization gate.
The kernel's root Host lookup also uses the shared routing resolver; pending
and revoked domains do not select an app or forest destination. App
destinations come from the active registry, forest destinations from their
configuration.

Existing deployed `profile.forest_config.custom_domain` mappings, where that
legacy column exists, are **grandfathered for routing only** by the migration.
Each legacy use logs a warning. Main has no such column, and migration of a
database without it is valid. Grandfathering never creates a verification
attestation and never authorizes vault access. Successful TXT proof can
replace a legacy route; merely adding an unverified claim cannot interrupt
it. Operators should complete TXT verification to retire the warning.

## Domain-scoped credentials

The server-only domain credential resolver follows exactly:

`domain → verified binding → zoneOwner → active purpose/grantee-bound vault grant`

Import the Cloudflare credential into the zone owner's vault using #2260 and
grant it to the edge's authenticated DID for the agreed Cloudflare purpose.
The #2895 integration passes that DID and purpose to the resolver in-process.
Missing, expired, consumed, revoked, or ambiguous grants fail closed. The
resolver uses the existing grant fetch primitive and does not fall back to a
node-level environment token. Plaintext belongs only in the consuming
server's memory, never an API response, log, or command line.

### DNS adapter boundary (#2920)

`apps/kernel/src/lib/dns/provider.ts` provides an internal `resolveDnsProvider`
seam. Its per-domain configuration is either `{ provider: 'manual' }` or
`{ provider: 'cloudflare', zoneId }`; configuration contains identifiers, never
a credential. Cloudflare operations resolve `cloudflarePurpose(zoneId)`
(`dns.cloudflare:<zoneId>`) for the node's signing DID through
`resolveDomainCredential` on every apply, reusing the zone credential sealed by
the Cloudflare connector (#3003) without a second import or seal. No usable scoped
grant returns manual records/instructions; unverified ownership, vault failures
and provider failures do not silently become a successful write.

The adapters accept only domain-scoped TXT/CNAME records. They never change MX,
nameservers, addresses, mailboxes or inbound delivery. Cloudflare preflights the
whole plan, reads paginated record sets, preserves unrelated TXT records, refuses
conflicting CNAMEs and multiple existing SPF records, and merges required
positive SPF includes before the owner's existing `all`. Existing mechanisms,
includes, redirect and policy qualifiers are retained. Identical records are
not rewritten; mail CNAMEs are DNS-only. A later retry re-reads provider state,
including after a partial network failure. Provider errors are fixed codes,
without response bodies, headers or exception causes.

This is **not yet wired to `/jin`**, does not persist provider settings and does
not enable owner-domain sending. #2918's merged #2958 contains no implementation;
its supported Postal domain-management boundary still needs a decision. The
future integration must supply authoritative Postal records, enforce owner/admin
and delegation policy, serialize setup per domain, persist non-secret settings,
and poll actual verification before enabling mail. Cloudflare has no atomic
SPF compare-and-swap here: concurrent external DNS edits require reconciliation.
The current credential primitive also requires an already verified binding;
this adapter cannot bootstrap ownership for a pending claim. Its verification
TXT support is for an already verified domain, not an ownership bypass.

## Acceptance verification

The domain integration tests exercise PostgreSQL-compatible migrations twice,
TXT success and loss, persisted signatures, distinct zone/site owners,
Imajin organization issuance and vault-grant authorization. Provisioning,
HTTP contract, management authorization, settings and profile tests cover the
remaining seams.

Live dev sign-off additionally requires the deployed migration, GBS's real
app registry owner, the organization's signing grant, a test DNS record under
the DNS account holder's control, and app-host forwarding of the well-known
path. Do not claim that these live external-account steps ran merely because
the automated tests passed.
