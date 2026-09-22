# Point your Muse at Imajin

This is a runbook for a stranger — human or agent — who wants to connect their
Meta Muse (or Muse Code, or any other MCP/OAuth-speaking client) to an Imajin
node and read their own media through it. It also documents what proves the
call is real.

**Availability check first:** Muse launched US-only on 2026-09-08 and expanded
to Canada on 2026-09-18/19. If you're outside both, Muse itself will tell you
it isn't available yet — that's a Meta rollout limit, not an Imajin one.

## Which path applies to you

Meta ships two different products under the "Muse" name, and they connect
differently. Read this section before pasting anything.

- **Muse (the app on your phone / muse.ai)** — its "Custom Connector" feature
  does **not** speak MCP. It reads a public **OpenAPI spec** and writes its own
  REST client on its Secure VM, authenticated with a **bearer token you paste
  once** into Muse's Secure Credentials Store. Use **Path A** below.
- **Muse Code (the terminal coding agent)** — this one *does* speak MCP, over
  a remote HTTP transport, configured in `~/.config/muse/settings.json`. It
  authenticates with a **static header you set yourself** — there's no
  in-product browser login step. Use **Path B** below.

Neither path drives a browser-based OAuth login the way Claude Desktop's MCP
connector does. Both now have a real, long-lived credential to use — the
**delegate-grant bearer** shipped in [#2252](https://github.com/ima-jin/imajin-ai/issues/2252):
a scoped, revocable, sliding-expiry bearer, never a plain personal-access
token (the NOT-PAT rule, #1340). It is minted through a **knock -> approve ->
paste** ceremony, not the interactive OAuth dance — see "Connect Muse: knock
-> approve -> paste bearer" below for the full runbook. Path A and Path B
both point into that runbook at the step where they need the credential.

## Connect Muse: knock -> approve -> paste bearer

This is the #2252 flow both Path A and Path B below use to get a real,
long-lived credential — a **delegate-grant bearer**, bound to the client and
purpose you name, never a general-purpose personal access token.

1. **Knock.** Sign in to your own node's `/jin` dashboard
   (`https://jin.imajin.ai/jin`) and find the "Delegate-grant bearers"
   section. Fill in the knock form:
   - **Client label** — e.g. `Muse Code` or `Muse custom connector`.
   - **Purpose** — a short human-readable reason, e.g. `read my media library`.
   - **Scopes** — comma-separated, e.g. `discovery:read, corpus:read`. Only
     ask for what the client actually needs — the bearer can never carry
     more than you request here.
   - **Surface** — `mcp` (the only surface this ships with end-to-end; see
     the PR's "decisions for review" note on why a REST surface like `media`
     isn't wired up yet).
   - **Idle window** — how long the bearer survives without a single use
     (30/90/180/365 days, default 90). It slides forward on every valid call
     but is dead 90 days after issuance no matter what (the hard cap).

   Submitting raises a `POST /auth/api/access/knock` request, which pends for
   24h waiting on a decision.
2. **Approve.** As the node operator, open the "Operator approvals" panel
   right below the knock form on `/jin`. The card names the client, purpose,
   scopes, and surface you knocked with. Tap **Approve & mint bearer** —
   approving on the canvas IS the signing event (the operator's own key
   countersigns the decision, #2084). The response includes the bearer
   **exactly once**, shown in a reveal box with a copy button — it is never
   retrievable again after you navigate away.
3. **Paste.** Copy the plaintext bearer into the client's credential store:
   - Meta Muse custom connector — paste it into Muse's Secure Credentials
     Store prompt when it asks for the `Authorization: Bearer <token>` value
     (see Path A below).
   - Muse Code — paste it into the `headers.Authorization` field of
     `~/.config/muse/settings.json` (see Path B below).
4. **Use.** Every accepted call slides the bearer's idle-window expiry
   forward — an actively used connection never needs re-consent. An
   abandoned one dies on its own once the idle window elapses, and every
   bearer dies at the 90-day hard cap regardless of use.
5. **Revoke.** From the same `/jin` panel, tap **Revoke** on the bearer's
   card at any time. This is immediate — the very next call with the old
   plaintext fails with `401 invalid_token`, indistinguishable from a bearer
   that never existed (the credential's hash is erased, not merely flagged).

## Path A — Muse custom connector (OpenAPI + bearer token)

1. In Muse, ask it to build a custom connector:

   > Build a custom connector for Imajin Media. The OpenAPI spec is at
   > `https://jin.imajin.ai/media/api/spec`. Auth is
   > `Authorization: Bearer <token>`. I'll paste the token into the secure
   > credential prompt, not the chat.

2. Muse fetches the spec and shows you the read operations it found
   (`GET /api/health`, `POST /api/assets`, and friends — see the spec for the
   full surface).
3. Run the "Connect Muse: knock -> approve -> paste bearer" runbook above,
   choosing scopes that cover the media operations you want Muse to reach,
   then paste the revealed bearer into Muse's secure credential prompt.
   **Note:** this doc's REST/media surface support in #2252 is still
   follow-up work (see the PR's "decisions for review" note) — today the
   bearer authenticates cleanly only on the `mcp` surface (Path B). Treat
   this path as pending that follow-up.

## Path B — Muse Code (remote MCP, static header)

1. Run the "Connect Muse: knock -> approve -> paste bearer" runbook above
   with **surface `mcp`** and whatever scopes Muse Code needs (e.g.
   `discovery:read`, `corpus:read`). Copy the revealed bearer.
2. Add the server to `~/.config/muse/settings.json`:

   ```json
   { "mcp_servers": {
       "imajin": {
         "transport": "streamable_http",
         "url": "https://mcp.imajin.ai/mcp",
         "headers": { "Authorization": "Bearer <delegate-grant bearer>" },
         "mode": "optional"
       }
   } }
   ```

3. This keeps working past the old 10-minute OAuth-token ceiling — every
   accepted call slides the idle-window expiry forward. If it ever stops
   working, the response tells you why: `401 invalid_token` (unknown or
   revoked), `401 token_expired` (idle window or the 90-day hard cap
   elapsed), or `403 insufficient_scope` (the bearer wasn't granted the
   surface/scope a tool needs) — knock again to get a fresh one.

## Path C — what actually happens on the wire (for verification, or for a client that *can* do browser OAuth)

This is the sequence a fully spec-compliant MCP+OAuth client (Claude Desktop,
and possibly a future reviewed Muse directory connector) drives automatically.
Documented here so you can verify it by hand with `curl`, or so a future Muse
capability can be checked against it. This is the default path for any client
that CAN do the browser-based dance — the knock/approve/paste runbook above
exists only for the static-header clients that structurally cannot.

1. **Discover.** `GET https://mcp.imajin.ai/.well-known/oauth-protected-resource`
   and `GET https://mcp.imajin.ai/.well-known/oauth-authorization-server` — both
   public, no auth. They tell the client the authorize/token/registration
   endpoints and the supported scopes.
2. **Register (DCR).** `POST https://mcp.imajin.ai/oauth/register` with a JSON
   body `{"redirect_uris": ["<your callback URL>"]}`. Returns a `client_id`,
   no secret (public client, PKCE-secured). Any spec-valid `https://` redirect
   URI (or an RFC 8252 loopback one) is accepted — nothing is pre-registered
   or allowlisted by name.
3. **Authorize.** Generate a PKCE `code_verifier` + S256 `code_challenge`,
   then open in a real browser:
   `https://mcp.imajin.ai/oauth/authorize?response_type=code&client_id=<id>&redirect_uri=<your callback>&scope=media:read&code_challenge=<challenge>&code_challenge_method=S256`
   - **You will be redirected to `jin.imajin.ai`, not `mcp.imajin.ai`, partway
     through.** That's correct: `mcp.imajin.ai` is the MCP-specific vhost,
     `jin.imajin.ai` is the node's own login/consent UI. Keep following
     redirects — your browser handles this automatically.
   - Log in if you aren't already.
   - You'll see a consent screen naming the connector and the scopes it's
     asking for (e.g. `media:read`). Approve it.
   - Your browser lands back on your `redirect_uri` with `?code=...&state=...`.
4. **Exchange the code.** `POST https://mcp.imajin.ai/oauth/token` with
   `grant_type=authorization_code`, the `code`, your `redirect_uri`, and the
   `code_verifier` from step 3, as `application/x-www-form-urlencoded`. Returns
   `access_token` (10 min), `refresh_token` (90 days), and the granted `scope`.
5. **List tools.** `POST https://mcp.imajin.ai/mcp` with
   `Authorization: Bearer <access_token>` and body
   `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`. Returns the tool
   registry — `media_list`, `media_get`, `media_get_content`, `media_resolve`,
   `ping`, and more, each with its JSON Schema.
6. **Call one scoped read tool.**
   `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"media_list","arguments":{}}}`
   — this requires the `media:read` scope you granted in step 3, and lists the
   media assets owned by *your* DID.

### What a first successful call looks like

```json
{"jsonrpc":"2.0","id":2,"result":{"resultType":"complete","content":[{"type":"text","text":"{\"count\":3,\"assets\":[...]}"}],"isError":false,"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"imajin-media-mcp","version":"0.2.0"}}}}
```

### What to do when it fails

- **`401 invalid_token`** — your access token expired (10 minutes) or wasn't
  sent. Use the `refresh_token` from step 4 against `/oauth/token` with
  `grant_type=refresh_token`, or re-run the authorize step.
- **`403 insufficient_scope`** — the token doesn't carry the scope the tool
  needs. Either you didn't request it in step 3, or it says
  `scope_token_stale` in the tool's error text — meaning the scope *is*
  granted in your account but this particular token predates it; refresh the
  token to pick it up.
- **`invalid_redirect_uri` at DCR** — your `redirect_uri` isn't `https://` (or
  an RFC 8252 loopback `http://localhost`/`127.0.0.1`), or it has a fragment
  or a wildcard. Fix the URI, not the server.
- **Redirect loop back to `/auth/login`** — you aren't logged in to
  `jin.imajin.ai` in that browser. Log in first, then retry the authorize URL.
- **A tool call returns `Error: ...` inside `content` rather than an HTTP
  error** — that's the MCP convention for in-band tool failures (bad
  arguments, asset not found, access denied); read the text, it's the whole
  answer.

## What this proves

A successful `tools/call` above is not just "the API responded." Walking back
the chain: the access token's `sub` claim is *your* DID, its `azp` claim is
the connector's own DID (promoted into a first-class actor identity the
moment you approved consent), and the consent itself was recorded as a
signed `app.authorized` attestation issued by your DID the moment you clicked
Approve. Every tool call executes with `ctx.did` = your DID and
`ctx.appDid` = the connector's DID — the call happens **as the connector,
acting on your behalf, with your explicit and revocable grant**, not as some
anonymous API key. Read-tools like `media_list` don't currently emit a
separate bus event (a write, like `media_create_article`, does — see
`bus.publish('asset.article.published', ...)` in the tool source), but the
access itself is gated by, and traceable to, that signed consent record the
whole way down. Revoking the connector (or the specific scope) from
`/auth/connectors` on `jin.imajin.ai` kills every future call immediately —
the sealed grant, not a shared secret, is the thing that has to be revoked.

## Reference

- Live discovery docs: `https://mcp.imajin.ai/.well-known/oauth-authorization-server`,
  `https://mcp.imajin.ai/.well-known/oauth-protected-resource`,
  `https://jin.imajin.ai/.well-known/agent.json`
- Spike log with the full command transcript: [`spikes/2250-muse-connector/README.md`](../../spikes/2250-muse-connector/README.md)
- Shipped: [#2252](https://github.com/ima-jin/imajin-ai/issues/2252) (delegate-grant bearer for static-header clients — the knock/approve/paste runbook above)
- Follow-ups tracked: [#2253](https://github.com/ima-jin/imajin-ai/issues/2253) (aggregate OpenAPI spec)
