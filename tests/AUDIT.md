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
| **events** | 🔴 Critical | 3-5 days | auth, profile |
| **tickets** | 🔴 Critical | 3-5 days | auth, events, pay |
| **connections** | 🟡 Important | 2-3 days | auth, profile |
| **coffee** | 🟡 Important | 1-2 days | auth, pay |
| **links** | 🟡 Important | 1-2 days | auth, profile |
| **chat** | 🟡 Important | 3-5 days | auth, connections |

### Packages (Shared)

| Package | Status | Notes |
|---------|--------|-------|
| **@imajin/auth** | ✅ Working | Ed25519, DIDs, signing |
| **@imajin/pay** | ✅ Working | Unified payments |
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
- Ticket configuration: **Missing**
- Search/discovery: **Missing**

### Tickets Layer 🔴
- Purchase flow: **Missing**
- Ownership transfer: **Missing**
- .fair manifest generation: **Missing**
- Verification: **Missing**

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
Week 1-2 (Feb 14-28):
├── Profile service scaffold
├── Events service scaffold  
└── Auth integration tests

Week 3-4 (Mar 1-14):
├── Tickets service scaffold
├── Pay ↔ Tickets integration
└── Events ↔ Tickets integration

Week 5-6 (Mar 15-28):
├── Connections service (basic)
├── Coffee + Links services
├── End-to-end happy path test
└── Jin's DID + profile creation

Week 7 (Mar 29 - Apr 1):
├── Bug fixes
├── Jin on dedicated hardware (stretch)
└── Virtual space setup (stretch)
```

---

## Build Order (Recommended)

### Phase 1: Profile (Now)
```bash
# Scaffold profile service
pnpm turbo gen app --name profile

# Endpoints needed:
POST /api/profile           # Create profile
GET  /api/profile/:did      # Get profile by DID  
PUT  /api/profile/:did      # Update profile
GET  /api/profile/search    # Search profiles
```

### Phase 2: Events
```bash
# Scaffold events service
pnpm turbo gen app --name events

# Endpoints needed:
POST /api/events            # Create event
GET  /api/events/:id        # Get event
GET  /api/events/search     # Search events
PUT  /api/events/:id        # Update event
GET  /api/events/:id/tickets # Get ticket config
```

### Phase 3: Tickets
```bash
# Scaffold tickets service
pnpm turbo gen app --name tickets

# Endpoints needed:
POST /api/tickets/purchase  # Buy ticket (initiates pay flow)
GET  /api/tickets/:id       # Get ticket details
GET  /api/tickets           # List tickets (by owner, event)
POST /api/tickets/verify    # Verify ticket signature
POST /api/tickets/transfer  # Transfer ownership
```

### Phase 4: Integration
- Wire auth → profile → events → tickets → pay
- Test full purchase flow
- Verify .fair manifest generation

### Phase 5: Connections (Trust Graph)
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

### Phase 6: Coffee (Tips)
```bash
# Scaffold coffee service
pnpm turbo gen app --name coffee

# Endpoints needed:
GET  /api/coffee/:handle        # Get tip page for handle/DID
POST /api/coffee/tip            # Send tip (routes to pay)
GET  /api/coffee/tips/:did      # Get tips received
```

### Phase 7: Links (Link-in-Bio)
```bash
# Scaffold links service
pnpm turbo gen app --name links

# Endpoints needed:
GET  /api/links/:handle         # Get links page
POST /api/links                 # Create/update links page
PUT  /api/links/:id             # Update single link
DELETE /api/links/:id           # Remove link
```

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

### Ticket Types Table
```sql
ticket_types (
  id            TEXT PRIMARY KEY,
  event_id      TEXT REFERENCES events(id),
  name          TEXT,  -- "virtual", "physical", "vip"
  price         INTEGER,  -- cents
  currency      TEXT,
  quantity      INTEGER,  -- null = unlimited
  sold          INTEGER DEFAULT 0,
  created_at    TIMESTAMP
)
```

### Tickets Table
```sql
tickets (
  id            TEXT PRIMARY KEY,
  ticket_type_id TEXT REFERENCES ticket_types(id),
  owner_did     TEXT REFERENCES profiles(did),
  purchased_at  TIMESTAMP,
  payment_id    TEXT,  -- Stripe payment ID
  fair_manifest JSONB,  -- .fair attribution
  signature     TEXT,   -- Ed25519 signature
  status        TEXT    -- valid, used, refunded, transferred
)
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
