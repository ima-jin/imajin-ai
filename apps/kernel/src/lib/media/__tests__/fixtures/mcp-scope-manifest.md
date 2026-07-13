---
kind: scope-manifest
connector: "did:imajin:mcp-connector"
channel: mcp
"media:read":
  verb: read
  surface: media
  label: "Read your media assets"
"media:write":
  verb: write
  surface: media
  label: "Create and update your media assets"
"media:share":
  verb: write
  surface: media-access
  label: "Grant or revoke other people's access to your assets"
"connections:read":
  verb: read
  surface: connections
  label: "Read your trust-graph connections"
release:
  "media:read":
    discloses_others: false
    sensitive: false
  "media:write":
    discloses_others: false
    sensitive: false
    release: on-consent
    viewer: "did:imajin:mcp-connector"
  "media:share":
    discloses_others: true
    sensitive: false
    release: on-consent
    viewer: "did:imajin:mcp-connector"
  "connections:read":
    discloses_others: false
    sensitive: false
---
# Claude/MCP connector — scope manifest

The connector is **inert until a DID consents**. Each row below is a named
capability the owner grants by editing this signed manifest; the grant projects
into the live permission DB (`auth.channel_links`) through the release-gated
reactor (#1207) and is revoked (#1208) by deleting the row.

Tiers derive from the #1196 consent 2×2 (self/others × sensitive/not):

- `media:read` — read × only-you → **silent** (freely projectable).
- `media:write` — write × only-you → tightened to **on-consent** (you see it).
- `media:share` — write × touches-others → **on-consent** (deliberate grant).
- `connections:read` — read × only-you → **silent** (freely projectable).
