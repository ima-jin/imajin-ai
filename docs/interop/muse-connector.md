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
connector does. **Today, Imajin has no long-lived, pasteable credential to
hand either of them** — our OAuth access tokens expire in 10 minutes and are
only mintable through the interactive authorize flow. This is tracked as
[#2252](https://github.com/ima-jin/imajin-ai/issues/2252). Until it ships, both
paths below stop at the point where you'd need that credential — **that is
where you should stop too**, rather than trying to work around it with an
access token that will go stale in 10 minutes.

## Path A — Muse custom connector (OpenAPI + bearer token)

1. In Muse, ask it to build a custom connector:

   > Build a custom connector for Imajin Media. The OpenAPI spec is at
   > `https://jin.imajin.ai/media/api/spec`. Auth is
   > `Authorization: Bearer <token>`. I'll paste the token into the secure
   > credential prompt, not the chat.

2. Muse fetches the spec and shows you the read operations it found
   (`GET /api/health`, `POST /api/assets`, and friends — see the spec for the
   full surface).
3. **Stop here for now.** The next step needs a bearer token scoped to your
   own media that stays valid for more than a few minutes, which Imajin
   doesn't yet issue (#2252). When that ships, this doc will be updated with
   exactly where to generate one.

## Path B — Muse Code (remote MCP, static header)

1. Get an access token the normal way: complete the OAuth dance below in a
   real browser tab (Path C describes it step by step), then copy the
   `access_token` from the token response.
2. Add the server to `~/.config/muse/settings.json`:

   ```json
   { "mcp_servers": {
       "imajin": {
         "transport": "streamable_http",
         "url": "https://mcp.imajin.ai/mcp",
         "headers": { "Authorization": "Bearer <access_token>" },
         "mode": "optional"
       }
   } }
   ```

3. This will work for **10 minutes**, then every call fails with 401
   `invalid_token` — our access tokens are short-lived by design and Muse
   Code's static-header MCP config has no way to refresh them. Don't build a
   real workflow on this until #2252 ships a token meant to be pasted once.

## Path C — what actually happens on the wire (for verification, or for a client that *can* do browser OAuth)

This is the sequence a fully spec-compliant MCP+OAuth client (Claude Desktop,
and — once #2252 ships — likely Muse's reviewed directory connector) drives
automatically. Documented here so you can verify it by hand with `curl`, or so
a future Muse capability can be checked against it.

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
- Follow-ups tracked: [#2252](https://github.com/ima-jin/imajin-ai/issues/2252) (static/pasteable credential), [#2253](https://github.com/ima-jin/imajin-ai/issues/2253) (aggregate OpenAPI spec)
