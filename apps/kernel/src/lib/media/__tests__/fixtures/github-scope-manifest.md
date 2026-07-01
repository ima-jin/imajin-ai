---
kind: scope-manifest
connector: "did:imajin:github-connector"
channel: github
"github:read":
  verb: read
  surface: repos
  label: "Read your own repos, issues and PRs"
"github:write":
  verb: write
  surface: issues
  label: "Open and comment on issues & PRs on your repos"
"github:org":
  verb: write
  surface: org
  label: "Act on repos owned by an org or other people"
"github:actions":
  verb: execute
  surface: actions
  label: "Trigger Actions / deploy / spend CI minutes"
release:
  "github:read":
    discloses_others: false
    sensitive: false
  "github:write":
    discloses_others: false
    sensitive: false
    release: on-consent
    viewer: "did:imajin:github-connector"
  "github:org":
    discloses_others: true
    sensitive: false
    viewer: "did:imajin:github-connector"
  "github:actions":
    discloses_others: true
    sensitive: true
---
# GitHub connector — scope manifest

The connector is **inert until a DID consents**. Each row below is a named
capability the owner grants by editing this signed manifest; the grant projects
into the live permission DB (`auth.channel_links`) through the release-gated
reactor (#1207) and is revoked (#1208) by deleting the row.

Tiers derive from the #1196 consent 2×2 (self/others × sensitive/not):

- `github:read` — read × only-you → **silent** (freely projectable).
- `github:write` — write × only-you → tightened to **on-consent** (you see it).
- `github:org` — touches others → **on-consent** (deliberate).
- `github:actions` — touches others + spends → **never** (never silent).
