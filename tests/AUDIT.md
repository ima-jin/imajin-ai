# Stack Audit: February 14, 2026

**Target: April 1 Launch Party**

---

## Current State

### Apps (Built)

| App | Status | Notes |
|-----|--------|-------|
| **auth** | ✅ Scaffold | Ed25519 signing, DID minting, challenge/auth |
| **pay** | ✅ Scaffold | Stripe + Solana, checkout, escrow |
| **registry** | ✅ Scaffold | Node federation, heartbeats, build verification |
| **dykil** | ✅ Scaffold | Community spending tracker |
| **karaoke** | ✅ Working | Event queue (proven pattern) |
| **learn** | ✅ Scaffold | AI training courses |
| **fixready** | ✅ Exists | (Purpose unclear) |

### Apps (Missing for Happy Path)

| App | Priority | Estimate | Dependency |
|-----|----------|----------|------------|
| **profile** | 🔴 Critical | 2-3 days | auth |
| **events** | 🔴 Critical | 5-7 days | auth, profile, pay |
| **connections** | 🟡 Important | 2-3 days | auth, profile |
| **coffee** | 🟡 Important | 1-2 days | auth, pay |
| **links** | 🟡 Important | 1-2 days | auth, profile |
| **chat** | 🟡 Important | 3-5 days | auth, connections |

### Packages (Shared)

| Package | Status | Notes |
|---------|--------|-------|
| **@imajin/auth** | ✅ Working | Ed25519, DIDs, signing |
| **@imajin/db** | 🟡 Planned | Database utilities |
| **@imajin/ui** | 🟡 Planned | Shared components |

---

## Gap Analysis

### Identity Layer ✅
- Keypair generation: **Done**
- DID creation: **Done**
- Challenge/auth flow: **Done**
- Human vs Agent typing: **Verify**

### Profile Layer 🔴
- Profile CRUD: **Missing**
- Avatar/metadata: **Missing**
- Invitation tracking: **Missing** (can stub in profile)

### Events Layer 🔴
- Event CRUD: **Missing**
- Ticket type configuration: **Missing**
- Purchase flow: **Missing**
- Ticket ownership + transfer: **Missing**
- .fair manifest generation: **Missing**
- Verification: **Missing**
- Search/discovery: **Missing**

### Payments Layer ✅
- Stripe checkout: **Done**
- Stripe charge: **Done**
- Solana support: **Done**
- Escrow: **Done**
- Webhooks: **Done**

### Trust Layer 🟡
- Connections CRUD: **Missing**
- Invitation chain: **Missing** (can stub)
- Network visualization: **Missing**
- Penalty cascade: **TODO** (deferred)

### Tips Layer 🟡
- Coffee (tips page): **Missing**
- Direct payments to Solana/Stripe: **Missing**

### Links Layer 🟡
- Link-in-bio pages: **Missing**
- Sovereign Linktree alternative: **Missing**

### Chat Layer 🔴
- Messaging: **Missing**
- Conversations: **Missing**

---

## Critical Path to April 1

```
Week 1 (Feb 14-21):
├── Profile service scaffold
├── Coffee service scaffold
└── Auth integration tests

Week 2 (Feb 22-28):
├── Links service scaffold
├── Chat service scaffold
└── Profile ↔ Coffee ↔ Links integration

Week 3-4 (Mar 1-14):
├── Events service (full, with ticketing)
├── Events ↔ Pay integration
├── Ticket minting + .fair manifests
└── End-to-end happy path test

Week 5 (Mar 15-21):
├── Connections service (trust graph)
├── Jin's DID + profile creation
└── Bug fixes + polish

Week 6-7 (Mar 22 - Apr 1):
├── Final integration testing
├── Jin on dedicated hardware (stretch)
└── Virtual space setup (stretch)

Week 7 (Mar 29 - Apr 1):
├── Bug fixes
├── Jin on dedicated hardware (stretch)
└── Virtual space setup (stretch)
```

---

## Build Order

### Phase 1: Profile
```bash
# Scaffold profile service
pnpm turbo gen app --name profile

# Endpoints needed:
POST /api/profile           # Create profile
GET  /api/profile/:did      # Get profile by DID  
PUT  /api/profile/:did      # Update profile
GET  /api/profile/search    # Search profiles
```

### Phase 2: Events (includes ticketing)
```bash
# Scaffold events service
pnpm turbo gen app --name events

# Event endpoints:
POST /api/events              # Create event + ticket types
GET  /api/events/:id          # Get event
GET  /api/events/search       # Search events
PUT  /api/events/:id          # Update event

# Ticket endpoints:
POST /api/events/:id/purchase # Buy ticket (initiates pay flow)
GET  /api/tickets/:id         # Get ticket details
GET  /api/my/tickets          # List my tickets
POST /api/tickets/verify      # Verify ticket signature
POST /api/tickets/:id/transfer # Transfer ownership
```

### Phase 3: Links
```bash
# Scaffold links service
pnpm turbo gen app --name links

# Endpoints needed:
POST /api/pages               # Create links page
GET  /api/pages/:handle       # Get links page
PUT  /api/pages/:handle       # Update page
POST /api/pages/:handle/links # Add link
GET  /api/pages/:handle/stats # Get click stats
```

### Phase 4: Chat
```bash
# Scaffold chat service
pnpm turbo gen app --name chat

# Endpoints needed:
GET  /api/conversations         # List conversations
POST /api/conversations         # Create conversation
GET  /api/conversations/:id/messages # Get messages
POST /api/conversations/:id/messages # Send message
WS   /ws                        # Real-time connection
```

### Phase 5: Events (with ticketing)
```bash
# Scaffold events service
pnpm turbo gen app --name events

# Event endpoints:
POST /api/events              # Create event + ticket types
GET  /api/events/:id          # Get event
GET  /api/events/search       # Search events

# Ticket endpoints:
POST /api/events/:id/purchase # Buy ticket
GET  /api/tickets/:id         # Get ticket
POST /api/tickets/verify      # Verify ticket
```

### Phase 6: Connections
```bash
# Scaffold connections service
pnpm turbo gen app --name connections

# Endpoints needed:
POST /api/connections           # Create connection (vouch for someone)
GET  /api/connections/:did      # Get connections for a DID
DELETE /api/connections/:id     # Remove connection
GET  /api/connections/tree/:did # Get invitation tree from DID
GET  /api/trust/:did            # Get trust score (stub)
```

### Phase 2: Coffee
```bash
# Scaffold coffee service
pnpm turbo gen app --name coffee

# Endpoints needed:
GET  /api/coffee/:handle        # Get tip page for handle/DID
POST /api/coffee/tip            # Send tip (routes to pay)
GET  /api/coffee/tips/:did      # Get tips received
```

### Phase 7: Integration & Polish
- Wire all services together
- Test full purchase flow
- Verify .fair manifest generation
- Jin's DID + profile creation

---

## Database Needs

### Profile Table
```sql
profiles (
  did           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  display_type  TEXT,  -- "human", "agent", "presence"
  avatar        TEXT,
  bio           TEXT,
  invited_by    TEXT REFERENCES profiles(did),
  metadata      JSONB,
  created_at    TIMESTAMP,
  updated_at    TIMESTAMP
)
```

### Events Table
```sql
events (
  id            TEXT PRIMARY KEY,
  creator_did   TEXT REFERENCES profiles(did),
  title         TEXT NOT NULL,
  description   TEXT,
  date          TIMESTAMP,
  location      JSONB,  -- { virtual: bool, physical: { city, venue } }
  status        TEXT,   -- draft, published, cancelled, completed
  created_at    TIMESTAMP,
  updated_at    TIMESTAMP
)
```

### Events + Tickets Tables
```sql
-- See apps/events/PROJECTS.md for full schema
-- events, ticket_types, tickets, ticket_transfers
```

### Connections Table
```sql
connections (
  id            TEXT PRIMARY KEY,
  from_did      TEXT REFERENCES profiles(did),
  to_did        TEXT REFERENCES profiles(did),
  type          TEXT,  -- follow, trust, block
  invited_by    TEXT REFERENCES profiles(did),
  created_at    TIMESTAMP,
  UNIQUE(from_did, to_did)
)
```

### Coffee Table (Tips)
```sql
coffee_pages (
  id            TEXT PRIMARY KEY,
  did           TEXT REFERENCES profiles(did),
  handle        TEXT UNIQUE,
  title         TEXT,
  bio           TEXT,
  stripe_acct   TEXT,          -- Stripe Connect account
  solana_addr   TEXT,          -- Solana wallet address
  created_at    TIMESTAMP
)

tips (
  id            TEXT PRIMARY KEY,
  to_page       TEXT REFERENCES coffee_pages(id),
  from_did      TEXT,          -- null for anonymous
  amount        INTEGER,
  currency      TEXT,
  message       TEXT,
  payment_id    TEXT,
  created_at    TIMESTAMP
)
```

### Links Table
```sql
link_pages (
  id            TEXT PRIMARY KEY,
  did           TEXT REFERENCES profiles(did),
  handle        TEXT UNIQUE,
  title         TEXT,
  bio           TEXT,
  avatar        TEXT,
  theme         JSONB,
  created_at    TIMESTAMP
)

links (
  id            TEXT PRIMARY KEY,
  page_id       TEXT REFERENCES link_pages(id),
  title         TEXT,
  url           TEXT,
  icon          TEXT,
  position      INTEGER,
  clicks        INTEGER DEFAULT 0,
  created_at    TIMESTAMP
)
```

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Time crunch | High | Ruthless prioritization, cut connections/chat |
| Integration complexity | Medium | Test each service independently first |
| Stripe production setup | Medium | Apply for production access early |
| Hardware (Jin's Pi) | Medium | Can demo on Ryan's hardware if needed |
| Virtual space (Unreal) | Low | Nice to have, not required |

---

## Next Actions

1. [ ] Scaffold profile service
2. [ ] Scaffold events service
3. [ ] Verify auth handles agent type
4. [ ] Test pay checkout flow standalone
5. [ ] Create Jin's DID (genesis agent)

---

*46 days. Let's build.*
