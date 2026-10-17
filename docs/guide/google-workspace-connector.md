# Google Workspace connector (#2144)

A DID connects a Google account (Workspace or plain Google) via **OAuth2
authorization-code with offline access**. No PATs, no service-account JSON, no
app passwords. The resulting refresh token is sealed per-DID in the vault and
`google_*` MCP tools use it to act `onBehalfOf` the connecting DID — see
`apps/kernel/src/lib/google/connector.ts` for the implementation and
`apps/kernel/api-spec/google.yaml` for the route contracts.

## Custody — say it plainly

Kernel holds the refresh token = "Imajin can act on your mailbox while you are
away." This is disclosed verbatim on the connector card
(`ConnectorEntry.custodyNotice`), not left implicit.

## Scope catalogue

| Capability | Scope | Google API scope | Signed event |
| --- | --- | --- | --- |
| Read Gmail | `google:gmail:read` | `gmail.readonly` | `mail.received` (push) |
| Send/draft Gmail | `google:gmail:send` | `gmail.send` | `mail.sent` |
| Read Calendar | `google:calendar:read` | `calendar.readonly` | — |
| Write Calendar (+ Meet links) | `google:calendar:write` | `calendar.events` | `calendar.entry.created` (existing intention-model event, #1788 — see note below) |
| Read Drive | `google:drive:read` | `drive.readonly` | `drive.file.changed` |
| Meet records/transcripts | `google:meet:records` | `meetings.space.readonly` | `meet.transcript.available` |
| Search Console sites, search analytics, URL inspection | `google:search-console:read` | `webmasters.readonly` | `google.data.read` |
| Business Profile locations and reviews (feature gated) | `google:business-profile:read` | `business.manage` | `google.data.read` |

All scopes are `owner-only` (#1196): the owner's own sealed refresh token
is spent on every call and never released to a third party. v2 —
**deliberately not implemented here** — adds `google:contacts:read`,
`google:admin:reports` (Admin audit-log ingestion + proactive
revocation-propagation), and `google:sheets:write`.

**Note on `calendar.event.created`:** the issue names this event, but Calendar
writes land in the existing intention-model store
(`kernel.calendar_entries`, #1788) rather than a parallel table, so they reuse
that store's own `calendar.entry.created` event (`type: 'event'`,
`metadata.source: 'google'`) instead of forking a second calendar event
vocabulary.

## Google Cloud Console setup

1. **Create or reuse an OAuth client.** Google Cloud Console → APIs &
   Services → Credentials → Create Credentials → OAuth client ID → Web
   application. This is a **bring-your-own app**: every DID (or an
   administrator, for a Workspace-wide setup) registers and owns their own
   OAuth client — imajin never holds a shared Google OAuth client.
2. **Configure the OAuth consent screen** with only the capabilities needed by
   this connection. For Search Console alone, add
   `https://www.googleapis.com/auth/webmasters.readonly`. Workspace capabilities
   remain independently selectable:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/meetings.space.readonly`
3. **Set the redirect URI** to `https://<node>.imajin.ai/google/api/callback`
   (or `http://localhost:3000/google/api/callback` for local dev) — must
   match byte-for-byte what is sealed via `POST /google/api/configure`.
4. **Enable the required APIs**: Search Console API for site analytics and URL
   inspection; enable Gmail, Calendar, Drive or Meet only when selected.
5. Seal the client via `POST /google/api/configure` with
   `{ clientId, clientSecret, redirectUri }`, then connect via
   `GET /google/api/connect`.

### Search Console: identity → connection → app

Choose the organisation identity before configuring Google. On its Google
connector card, select the connection slot (for example `business`), seal that
connection's OAuth client in the identity's vault, and enable only
`google:search-console:read` in its scope manifest. Connect Google and approve
that scope. No Gmail, Calendar or Drive permission is needed.

Consent is incremental per identity **and connection slot**. The connect URL
reads that slot's selected manifest scopes, requests their Google equivalents,
and sends `include_granted_scopes=true`; it never requests the entire catalogue.
Adding another capability requires reconnecting to obtain Google's consent.
An empty selection cannot start authorization. Google's previously granted
permissions may remain on an existing token, but removing a manifest scope
denies its use immediately.

Grant the app `google:search-console:read` through the existing MCP consent
surface. Its access token's resource-owner subject is the organisation identity,
not the app. Use the `/mcp` `tools/call` endpoint:

- `google_search_console_list_sites` lists Google's accessible properties.
- `google_search_console_query_analytics` reads a property's query/page/date
  metrics with `siteUrl`, `startDate`, `endDate` and optional dimensions.
- `google_search_console_inspect_url` inspects `inspectionUrl` under `siteUrl`.

Pass `connection` to select the slot or its unique label; otherwise `primary`
is used. Property identifiers may be URL properties (`https://example.com/`) or
domain properties (`sc-domain:example.com`). The connecting Google account must
have permission to access the property. Google enforces property access; a
manifest grant does not manufacture Google verification or ownership.

Calls enforce the app grant, connection grant and sealed credential. Successful
reads record signed `onBehalfOf` provenance for the identity and connection
without putting analytics or review content in the audit payload.

### Business Profile: disabled until approved

`GOOGLE_BUSINESS_PROFILE_ENABLED` is a non-secret operator feature flag,
**off by default**; only the exact value `true` enables it. Keep it off until
Google approves Business Profile API access for the OAuth client's Cloud
project. This approval is separate from OAuth consent verification and Search
Console access. Do not wait for it to start using Search Console.

The identity admin submits the request through
[Google's Business Profile API access process](https://developers.google.com/my-business/content/prereqs).
Include the Cloud project number, business website, use case (reading the
business's own locations and reviews with owner consent), and contact details.
Track the case in the card's setup checklist; credentials must never be pasted
into the case, chat or environment files.

After project approval, record the Business Profile step as approved, enable the
operator flag, enable `google:business-profile:read` for the selected connection
and reconnect. The provider requires `business.manage` even though Imajin
exposes only reads here. The read tools are
`google_business_profile_list_locations` and
`google_business_profile_list_reviews`; there are no review-reply, edit or
delete tools. Locations use an account resource and reviews use an
account/location resource. Pagination tokens are passed through.

The card's versioned checklist tracks project selection, API enablement,
OAuth consent/verification, Business Profile approval, vault import and connect.
`Pending Google` is a durable state with its start time and rejection guidance,
not an indication that Search Console is disabled. Admin-reported approval is
not a substitute for Google's provider-side checks.

The checklist is served by `GET /google/api/setup?slot=business`; session-bound
admins update one step using `PATCH` and run a live, signed Search Console
capability test using `POST`. It records no credentials, site data or arbitrary
notes. The existing configure form is the Google OAuth import path: it seals
the ID/secret directly into the identity's vault and clears the masked fields
after submission. The generic static-secret Import card tracked by #2260 is
separate; no new node-level secret importer is introduced here.

Reimporting an OAuth client clears this slot's recorded Business approval.
Reconfirm approval for the new client's project before using Business Profile;
an approval for a different project must not silently carry over.

### The verification wrinkle (know this before connecting)

Gmail's `gmail.readonly` / `gmail.send` scopes are Google **restricted**
scopes. Because the OAuth client above is registered by the connecting party
(not by Google/imajin), it is an *external* app to any Workspace tenant it
connects to, which normally triggers Google's OAuth verification + CASA
security assessment before restricted scopes can be granted.

- **Workspace tenants** (e.g. Artifact's `artifactads` domain): a tenant admin
  marks the OAuth client **Trusted** in the Admin console
  (Security → API Controls → Manage Third-Party App Access), which lets
  users in that Workspace grant restricted scopes without going through
  Google's verification flow. This is an onboarding step for each connecting
  Workspace tenant, not a one-time platform setup.
- **Personal Gmail accounts** (non-Workspace): there is no equivalent escape
  hatch. A personal-Gmail connection eventually needs the OAuth client to pass
  Google's real verification + CASA assessment. This is explicitly **out of
  scope** for this connector's v1 and is tracked as a follow-up when a
  personal-Gmail consumer needs it (see issue #2144).

## Environment variables (names only — never commit values)

- The cron bearer secret gating `/api/cron/*` routes, including the Gmail
  watch-renewal sweep this connector adds, is **not** an env var: it is a
  vault-generated internal secret (purpose `kernel.cron-secret`) shared with the
  `*-kernel-cron` scheduler by a vault grant. Nothing to set for this connector.
- `GOOGLE_GMAIL_PUBSUB_TOPIC` — the fully-qualified Pub/Sub topic name
  (`projects/<project>/topics/<topic>`) Gmail publishes push notifications to.
  Provisioned once per Google Cloud project outside this repo (Pub/Sub topic +
  push subscription pointed at `POST /google/api/webhook/gmail`, with the
  Gmail API's service account granted `pubsub.topics.publish` on the topic —
  see Google's
  [Gmail push notifications guide](https://developers.google.com/gmail/api/guides/push)).

No client secret, refresh token, or any other credential is ever an
environment variable for this connector — every credential is a per-DID
sealed vault entry, following the same custody model as every other OAuth
connector in this repo.
