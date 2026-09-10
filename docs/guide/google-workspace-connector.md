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

## v1 scope table

| Capability | Scope | Google API scope | Signed event |
| --- | --- | --- | --- |
| Read Gmail | `google:gmail:read` | `gmail.readonly` | `mail.received` (push) |
| Send/draft Gmail | `google:gmail:send` | `gmail.send` | `mail.sent` |
| Read Calendar | `google:calendar:read` | `calendar.readonly` | — |
| Write Calendar (+ Meet links) | `google:calendar:write` | `calendar.events` | `calendar.entry.created` (existing intention-model event, #1788 — see note below) |
| Read Drive | `google:drive:read` | `drive.readonly` | `drive.file.changed` |
| Meet records/transcripts | `google:meet:records` | `meetings.space.readonly` | `meet.transcript.available` |

All six scopes are `owner-only` (#1196): the owner's own sealed refresh token
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
2. **Configure the OAuth consent screen** with the six scopes above:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/meetings.space.readonly`
3. **Set the redirect URI** to `https://<node>.imajin.ai/google/api/callback`
   (or `http://localhost:3000/google/api/callback` for local dev) — must
   match byte-for-byte what is sealed via `POST /google/api/configure`.
4. **Enable the required APIs**: Gmail API, Google Calendar API, Google Drive
   API, Google Meet API (Meet REST API, for conference records/transcripts).
5. Seal the client via `POST /google/api/configure` with
   `{ clientId, clientSecret, redirectUri }`, then connect via
   `GET /google/api/connect`.

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

- `CRON_SECRET` — shared bearer secret gating `/api/cron/*` routes, including
  the Gmail watch-renewal sweep this connector adds. Already used by every
  other cron route in this repo.
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
