# Verified domain ownership

Domain ownership has two distinct parties: the DNS **zone owner** and the
**site owner** recorded on the active registered app. Hosting an app does not
make Imajin its owner. A custom domain can have a different zone owner from
its app's site owner.

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

The site owner is resolved from the registry, never from caller-supplied
`siteOwner` data. Agent delegates cannot execute ownership-affecting domain
mutations: the shared #2360 policy returns `AGENT_APPROVAL_REQUIRED`. They can
propose the action for the owner to execute.

The management endpoints are under
`/auth/api/identities/:did/domains`; see
`apps/kernel/api-spec/domains.yaml` for the full contract. Public verified
evidence is available at `/auth/api/identities/:did/domains/public` and is
linked from that identity's profile.

## Imajin-issued app hosts

The existing countersigned `POST /api/apps/provision` proposal accepts
`siteOwnerDid` and a direct `imajin.ai` subdomain such as
`dev-gbs.imajin.ai`. New apps default to the approving operator as site owner
and `<slug>.imajin.ai` as host. The proposal displays the owner and host before
approval. Reissuing a signing-key claim cannot transfer ownership.

Issuance uses the existing unique `@imajin` business identity, not an arbitrary
node claiming to be Imajin. Bootstrap that organization's signing key through
the vault, with an active `domain.issue` purpose grant to the configured node
DID. The kernel checks the fetched key against the organization's registered
public key before signing. Missing organization identity, missing grant, or a
key mismatch fails provisioning at the domain step rather than publishing
unsigned ownership. No organization key or domain credential belongs in an
environment file.

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
