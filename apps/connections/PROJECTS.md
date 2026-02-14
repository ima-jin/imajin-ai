# apps/connections — connections.imajin.ai

**Status:** 🔴 Not Started  
**Domain:** connections.imajin.ai  
**Port:** 3008  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Trust graph for the sovereign network. Who knows whom. Who vouched for whom. Visualize your network and beyond.

**What it does:**
- Create/manage connections between DIDs
- Track invitation chains (who brought whom into the network)
- Visualize network as navigable tree
- Trust scores based on connection graph
- Explore paths between any two identities

**What it doesn't do:**
- Messaging (that's `chat`)
- Identity management (that's `auth` + `profile`)
- Social posting (not built yet)

---

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/connections` | Create connection (vouch) | Required |
| GET | `/api/connections/:did` | Get connections for a DID | No |
| DELETE | `/api/connections/:id` | Remove connection | Required |
| GET | `/api/connections/tree/:did` | Get invitation tree from DID | No |
| GET | `/api/connections/path` | Find path between two DIDs | No |
| GET | `/api/trust/:did` | Get trust score | No |
| POST | `/api/invite` | Generate invitation link | Required |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Network explorer landing |
| `/:did` | View connections for a DID |
| `/tree/:did` | Visualize invitation tree |
| `/path` | Find path between two people |
| `/invite` | Generate invite link (auth required) |

---

## Data Model

### Connection
```typescript
interface Connection {
  id: string;                     // conn_xxx
  fromDid: string;                // Who initiated
  toDid: string;                  // Who they connected to
  type: 'follow' | 'trust' | 'block';
  invitedBy?: string;             // If toDid was invited by fromDid
  note?: string;                  // Optional note ("met at conference")
  createdAt: Date;
}

interface Invitation {
  id: string;                     // inv_xxx
  fromDid: string;                // Inviter
  token: string;                  // Unique invite token
  usedBy?: string;                // DID who used it
  usedAt?: Date;
  expiresAt?: Date;
  maxUses: number;                // 1 = single use
  useCount: number;
  createdAt: Date;
}

interface TrustScore {
  did: string;
  score: number;                  // 0-100
  connections: number;
  invitedCount: number;           // How many they've invited
  invitedBy?: string;             // Who invited them
  depth: number;                  // Degrees from genesis
  lastUpdated: Date;
}
```

---

## Database Schema

```sql
CREATE TABLE connections (
  id          TEXT PRIMARY KEY,
  from_did    TEXT NOT NULL,
  to_did      TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'follow'
                CHECK (type IN ('follow', 'trust', 'block')),
  invited_by  TEXT,                          -- from_did invited to_did
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_did, to_did)
);

CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,
  from_did    TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  used_by     TEXT,
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE trust_scores (
  did           TEXT PRIMARY KEY,
  score         INTEGER NOT NULL DEFAULT 50,
  connections   INTEGER NOT NULL DEFAULT 0,
  invited_count INTEGER NOT NULL DEFAULT 0,
  invited_by    TEXT,
  depth         INTEGER NOT NULL DEFAULT 0,    -- 0 = genesis
  last_updated  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_connections_from ON connections(from_did);
CREATE INDEX idx_connections_to ON connections(to_did);
CREATE INDEX idx_connections_type ON connections(type);
CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_from ON invitations(from_did);
CREATE INDEX idx_trust_scores_score ON trust_scores(score DESC);
```

---

## Usage

### Create Connection
```typescript
const response = await fetch('https://connections.imajin.ai/api/connections', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    toDid: 'did:imajin:friend123',
    type: 'follow',
    note: 'Met at Jin\'s launch party',
  }),
});
```

### Get Connections
```typescript
// Get who someone follows
const response = await fetch('https://connections.imajin.ai/api/connections/did:imajin:xxx?direction=outgoing');

// Get who follows someone
const response = await fetch('https://connections.imajin.ai/api/connections/did:imajin:xxx?direction=incoming');

// Get both
const response = await fetch('https://connections.imajin.ai/api/connections/did:imajin:xxx');
```

### Get Invitation Tree
```typescript
// Get everyone invited by this DID (and who they invited, recursively)
const response = await fetch('https://connections.imajin.ai/api/connections/tree/did:imajin:jin123?depth=3');

const { tree } = await response.json();
// {
//   did: "did:imajin:jin123",
//   name: "Jin",
//   invited: [
//     { did: "...", name: "Ryan", invited: [...] },
//     { did: "...", name: "Alice", invited: [...] }
//   ]
// }
```

### Find Path
```typescript
// How is Alice connected to Jin?
const response = await fetch('https://connections.imajin.ai/api/connections/path?from=did:imajin:alice&to=did:imajin:jin');

const { path, degrees } = await response.json();
// { path: ["did:imajin:alice", "did:imajin:bob", "did:imajin:jin"], degrees: 2 }
```

### Generate Invite
```typescript
const response = await fetch('https://connections.imajin.ai/api/invite', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    maxUses: 5,
    expiresIn: '7d',
  }),
});

const { inviteUrl, token } = await response.json();
// { inviteUrl: "https://imajin.ai/join?invite=xxx", token: "inv_xxx" }
```

---

## Tree Visualization

Network explorer at `connections.imajin.ai/tree/:did`:

```
                         Jin (genesis)
                              │
              ┌───────────────┼───────────────┐
              │               │               │
            Ryan           Debbie          Owen
              │               │
        ┌─────┴─────┐         │
        │           │         │
      Alice       Bob      Carol
        │
        │
      Dave
```

Interactive features:
- Click node to expand/collapse
- Hover for profile preview
- Click to navigate to that DID's tree
- Search to find anyone in the network
- Highlight path between two nodes

---

## Trust Score Algorithm (v1 - Simple)

```typescript
function calculateTrust(did: string): number {
  const base = 50;
  
  // Bonus for connections
  const connectionBonus = Math.min(connections.count * 2, 20);
  
  // Bonus for being close to genesis
  const depthPenalty = depth * 2;
  
  // Bonus for successful invites (people who stayed active)
  const inviteBonus = Math.min(activeInvitees * 5, 20);
  
  // Penalty for inviting bad actors (future)
  const cascadePenalty = 0; // TODO
  
  return Math.max(0, Math.min(100,
    base + connectionBonus - depthPenalty + inviteBonus - cascadePenalty
  ));
}
```

Trust scores are recalculated periodically, not on every request.

---

## Invitation Accountability

When you invite someone:
1. Your DID is recorded as their `invitedBy`
2. If they do harm (future: spam, abuse, fraud)
3. Their trust score drops
4. Your trust score drops by `harm * decay_factor`
5. Cascade continues up the chain with diminishing impact

This creates skin in the game for invitations.

---

## Integration

### With auth.imajin.ai
- Validates DIDs and tokens
- New registrations can include invite token

### With profile.imajin.ai
- Fetches names/avatars for tree visualization
- Links to full profiles

### With events.imajin.ai / tickets.imajin.ai
- Events can require minimum trust score
- VIP tickets for high-trust members

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
PROFILE_SERVICE_URL=https://profile.imajin.ai
NEXT_PUBLIC_BASE_URL=https://connections.imajin.ai
```

---

## TODO

- [ ] Scaffold Next.js app
- [ ] Database schema + Drizzle setup
- [ ] Connection CRUD APIs
- [ ] Invitation system
- [ ] Tree traversal queries
- [ ] Path finding algorithm
- [ ] Trust score calculation
- [ ] Tree visualization (D3.js or similar)
- [ ] Network explorer UI
- [ ] Auth integration
