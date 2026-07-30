# infra/buzz — Imajin Buzz relay

Self-hosted [Buzz](https://github.com/block/buzz) relay for the Imajin agent
workspace (#1414 / #1409).

**Stack:** Postgres 17 · Redis 7 · MinIO · `ghcr.io/block/buzz` (Rust relay)
**Host requirement:** Docker + Docker Compose v2.24.4+

---

## Quick start (demo)

### Step 1 — Copy and fill in secrets

```bash
cd infra/buzz
cp .env.example .env
```

Generate the stable secrets (run once — never rotate `BUZZ_RELAY_PRIVATE_KEY`):

```bash
echo "BUZZ_RELAY_PRIVATE_KEY=$(openssl rand -hex 32)"
echo "BUZZ_GIT_HOOK_HMAC_SECRET=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
echo "REDIS_PASSWORD=$(openssl rand -hex 16)"
echo "BUZZ_S3_ACCESS_KEY=$(openssl rand -hex 16)"
echo "BUZZ_S3_SECRET_KEY=$(openssl rand -hex 16)"
```

Paste each value into `.env`. Then set `RELAY_OWNER_PUBKEY` — Ryan's 64-char
hex pubkey (convert from `npub1…` using
`npx @cmdcode/nip19 decode npub1yourkey`).

For a public server, update `RELAY_URL`, `BUZZ_MEDIA_BASE_URL`, and
`BUZZ_CORS_ORIGINS` to use your domain/IP.

### Step 2 — Start the stack

```bash
docker compose up -d
docker compose logs -f relay   # watch for "Listening on 0.0.0.0:3000"
```

Liveness check:

```bash
curl -fsS http://localhost:3000/_liveness
```

### Step 3 — Get the Imajin agent's Nostr pubkey

Using the `buzz_status` MCP tool (requires a running imajin kernel with a
sealed key — run `buzz_connect` first if not already done):

```
buzz_status → { connected: true, nostr_pubkey: "<64-char hex>" }
```

Or via the scripts/buzz-live-post.ts helper (see below) — it derives and
prints the pubkey from `BUZZ_NOSTR_PRIVKEY`.

### Step 4 — Allowlist the agent on the relay

The relay uses NIP-29 group membership. Add the agent as a relay member:

```bash
# Inside the relay container
docker compose exec relay \
  buzz-admin add-member --pubkey <agent_64hex_pubkey>
```

Then add the agent to the demo channel (replace `<group-id>` with your
channel's NIP-29 ID):

```bash
docker compose exec relay \
  buzz-admin add-group-member --group <group-id> --pubkey <agent_64hex_pubkey>
```

> If `buzz-admin` is not available in the image, use the relay's REST API:
> ```bash
> # Add relay member (owner-signed NIP-29 kind:9002 event required)
> # Use buzz-cli or the Buzz desktop app to create the group and add the agent.
> ```

### Step 5 — Post the live demo message

Use the `buzz_send_message` MCP tool from the kernel (auto-injects DID tags
from the sealed nostr-key-binding attestation):

```
buzz_send_message({
  relay_url: "ws://localhost:3000",
  group_id:  "<group-id>",
  content:   "Hello from Jin 🐝 — first DID-tagged Imajin agent message"
})
→ { sent: true, event_id: "<64-char hex>" }
```

Or use the standalone demo script (no kernel required):

```bash
BUZZ_NOSTR_PRIVKEY=<privkey_hex> \
BUZZ_RELAY_URL=ws://localhost:3000 \
BUZZ_GROUP_ID=<group-id> \
BUZZ_MESSAGE="Hello from Jin 🐝 — live demo" \
BUZZ_OWNER_DID=did:imajin:ryan \
BUZZ_ATTESTATION_DIGEST=<digest_hex> \
  npx tsx scripts/buzz-live-post.ts
```

The script prints JSON with the sent event including all tags. Capture it:

```bash
BUZZ_NOSTR_PRIVKEY=... npx tsx scripts/buzz-live-post.ts | tee demo-log.json
```

### Step 6 — Verify in the Buzz desktop app

Open the [Buzz desktop app](https://github.com/block/buzz/releases/latest),
point it at `ws://localhost:3000` (or your server URL), and open the demo
channel. The message should appear with:
- `[imajin-did, did:imajin:ryan]`
- `[imajin-attestation, <digest>]`

Screenshot or log the `demo-log.json` and attach to issue #1414.

---

## Operational notes

### Backup these three things

1. `BUZZ_RELAY_PRIVATE_KEY` — relay signing identity (rotation = new relay)
2. Postgres volume — the canonical event store
3. `.env` file — all secrets

### Upgrade

```bash
docker compose pull relay
docker compose up -d relay
```

### Stop / teardown

```bash
docker compose down       # keep volumes
docker compose down -v    # ⚠️ destroys all data
```

### Why MinIO?

Buzz uses S3-compatible object storage for media blobs (Blossom protocol).
MinIO runs in-process in the same Compose stack. For production, replace it
with managed S3 and set `BUZZ_S3_ENDPOINT` accordingly.
