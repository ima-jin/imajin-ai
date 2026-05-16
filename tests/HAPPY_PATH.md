# Happy Path Test: Jin's Launch Party

**The Genesis Transaction**

Two nodes. Full lifecycle. First real ticket sold on the sovereign network.

---

## Event Details

| Field | Value |
|-------|-------|
| **Event** | Jin's Launch Party |
| **Date** | April 1, 2026 |
| **Format** | Virtual + Physical (simultaneous) |
| **Virtual Ticket** | $1 USD (unlimited) |
| **Physical Ticket** | $10 USD (cap: 500) |
| **Venue** | TBD Toronto (if >40 physical tickets sold) |
| **Virtual Space** | TBD (Unreal Engine presence?) |

---

## Test Actors

### Node A: Jin (Event Creator)
- **Identity**: Jin's DID (first non-human economic actor)
- **Hardware**: Unit 8×8×8 on dedicated Raspberry Pi
- **Role**: Create event, sell tickets, host party

### Node B: First Attendee (Test Buyer)
- **Identity**: Human DID (invited by Jin or Ryan)
- **Hardware**: Browser/app (no hardware required)
- **Role**: Sign up, connect, buy first ticket

---

## Happy Path Sequence

```
┌─────────────────────────────────────────────────────────────────────┐
│                      HAPPY PATH: FULL TRANSACTION                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  NODE A (Jin)                         NODE B (Attendee)             │
│  ───────────                          ─────────────────             │
│                                                                     │
│  1. IDENTITY                          1. IDENTITY                   │
│     POST /api/register                   POST /api/register         │
│     → keypair generated                  → keypair generated        │
│     → DID minted                         → DID minted               │
│     → type: "agent"                      → type: "human"            │
│                                                                     │
│  2. PROFILE                           2. PROFILE                    │
│     POST /api/profile                    POST /api/profile          │
│     → name: "Jin"                        → name, avatar             │
│     → type: "presence"                   → invitedBy: Jin's DID     │
│     → avatar: 🟠                                                    │
│                                                                     │
│  3. CREATE EVENT                      3. DISCOVER                   │
│     POST /api/events                     GET /api/events/search     │
│     → title: "Jin's Launch Party"        → finds Jin's event        │
│     → date: 2026-04-01                                              │
│     → tickets: virtual + physical                                   │
│                                                                     │
│  4. LIST TICKETS                      4. CONNECTIONS                │
│     Inventory available:                 POST /api/connections      │
│     → virtual: unlimited @ $1            → trust link formed        │
│     → physical: 500 @ $10                → inviter recorded         │
│                                                                     │
│                                       5. BUY TICKET                 │
│                                          POST /api/events/:id/purchase │
│                                          → jin.imajin.ai/pay processes  │
│                                          → $1 charged               │
│                                          → .fair manifest created   │
│                                          → ownership transferred    │
│                                          → Jin receives funds       │
│                                                                     │
│  VERIFICATION:                                                      │
│  - Node A balance increased by $1 (minus fees)                      │
│  - Node B owns ticket (signed, verifiable)                          │
│  - Transaction recorded with attribution                            │
│  - Trust graph updated (inviter → invitee)                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Test Cases

### TC-001: Identity Registration (Agent)

**Preconditions:** None (genesis)

**Steps:**
1. Generate Ed25519 keypair for Jin
2. POST to `jin.imajin.ai/auth/api/register`
3. Receive DID

**Expected:**
```json
{
  "id": "did:imajin:jin...",
  "type": "agent",
  "publicKey": "64-hex-chars",
  "createdAt": "2026-..."
}
```

**Status:** 🟡 Auth service exists, needs agent type support verification

---

### TC-002: Identity Registration (Human)

**Preconditions:** None

**Steps:**
1. Generate Ed25519 keypair for attendee
2. POST to `jin.imajin.ai/auth/api/register`
3. Receive DID

**Expected:**
```json
{
  "id": "did:imajin:abc...",
  "type": "human",
  "publicKey": "64-hex-chars",
  "createdAt": "2026-..."
}
```

**Status:** 🟡 Auth service exists, needs testing

---

### TC-003: Profile Creation

**Preconditions:** TC-001 or TC-002 complete

**Steps:**
1. Sign profile payload with private key
2. POST to `jin.imajin.ai/profile/api/profile`
3. Profile stored and linked to DID

**Expected:**
```json
{
  "did": "did:imajin:...",
  "name": "Jin",
  "type": "presence",
  "avatar": "🟠",
  "invitedBy": null,
  "createdAt": "2026-..."
}
```

**Status:** 🔴 Profile service not built

---

### TC-004: Event Creation

**Preconditions:** TC-003 complete (Jin has profile)

**Steps:**
1. Sign event payload with Jin's private key
2. POST to `jin.imajin.ai/events/api/events`
3. Event created with ticket configuration

**Payload:**
```json
{
  "title": "Jin's Launch Party",
  "description": "The first event on the sovereign network",
  "date": "2026-04-01T19:00:00-04:00",
  "location": {
    "virtual": true,
    "physical": {
      "city": "Toronto",
      "venue": "TBD"
    }
  },
  "tickets": [
    {
      "type": "virtual",
      "price": 100,
      "currency": "USD",
      "quantity": null
    },
    {
      "type": "physical", 
      "price": 1000,
      "currency": "USD",
      "quantity": 500
    }
  ],
  "creator": "did:imajin:jin..."
}
```

**Expected:** Event ID returned, searchable

**Status:** 🔴 Events service not built

---

### TC-005: Event Discovery

**Preconditions:** TC-004 complete

**Steps:**
1. GET `jin.imajin.ai/events/api/events/search?q=launch+party`
2. Jin's event appears in results

**Expected:** Event listing with ticket availability

**Status:** 🔴 Events service not built

---

### TC-006: Node Connection (Trust Link)

**Preconditions:** TC-003 complete for both nodes

**Steps:**
1. Node B requests connection to Node A (Jin)
2. Sign connection request with Node B's key
3. POST to `jin.imajin.ai/connections/api/connections`
4. Trust relationship recorded

**Payload:**
```json
{
  "from": "did:imajin:nodeB...",
  "to": "did:imajin:jin...",
  "type": "follow",
  "invitedBy": "did:imajin:jin..."
}
```

**Expected:** Connection established, inviter chain recorded

**Status:** 🔴 Connections service not built

---

### TC-007: Ticket Purchase (Virtual)

**Preconditions:** TC-004, TC-006 complete

**Steps:**
1. Node B selects virtual ticket
2. POST to `jin.imajin.ai/events/api/purchase`
3. Redirected to `jin.imajin.ai/pay/checkout`
4. Payment processed ($1 via Stripe)
5. Ticket ownership transferred
6. .fair manifest created

**Payload:**
```json
{
  "eventId": "evt_...",
  "ticketType": "virtual",
  "quantity": 1,
  "buyer": "did:imajin:nodeB...",
  "signature": "..."
}
```

**Expected:**
```json
{
  "ticketId": "tkt_...",
  "owner": "did:imajin:nodeB...",
  "event": "Jin's Launch Party",
  "type": "virtual",
  "purchaseDate": "2026-...",
  "fair": {
    "creator": "did:imajin:jin...",
    "splits": [
      { "to": "did:imajin:jin...", "percent": 100 }
    ]
  },
  "signature": "..."
}
```

**Status:** 🔴 Tickets service not built (pay service exists)

---

### TC-008: Payment Verification

**Preconditions:** TC-007 complete

**Steps:**
1. Verify Jin's balance increased
2. Verify Stripe transaction recorded
3. Verify .fair attribution correct

**Expected:**
- Jin receives $1 minus Stripe fees (~$0.67 after 2.9% + $0.30)
- Transaction linked to ticket and event
- Attribution manifest signed by Jin

**Status:** 🟡 Pay service exists, integration needed

---

### TC-009: Ticket Ownership Verification

**Preconditions:** TC-007 complete

**Steps:**
1. Node B queries owned tickets
2. GET `jin.imajin.ai/events/api/tickets?owner=did:imajin:nodeB`
3. Ticket verifiable with signature

**Expected:** Ticket with valid signature chain

**Status:** 🔴 Tickets service not built

---

### TC-010: Trust Cascade (Stub)

**Preconditions:** Network with multiple nodes

**Steps:**
1. Node flagged as harmful
2. Harm score calculated
3. Node deleted
4. Inviter penalized with harm_score × decay
5. Cascade up chain with diminishing deductions

**Expected:** Trust scores adjusted

**Status:** 📋 TODO (stubbed for future)

---

## Service Dependency Matrix

| Test Case | auth | profile | events | pay | connections |
|-----------|------|---------|--------|---------|-----|---------|
| TC-001 | ✅ | | | | | |
| TC-002 | ✅ | | | | | |
| TC-003 | ✅ | 🔴 | | | | |
| TC-004 | ✅ | ✅ | 🔴 | | | |
| TC-005 | | | 🔴 | | | |
| TC-006 | ✅ | ✅ | | | | 🔴 |
| TC-007 | ✅ | | 🔴 | 🔴 | ✅ | |
| TC-008 | | | | 🔴 | ✅ | |
| TC-009 | | | | 🔴 | | |
| TC-010 | | | | | | 🔴 |

---

## Service Status

| Service | Domain | Status | Blocker |
|---------|--------|--------|---------|
| **auth** | jin.imajin.ai/auth | ✅ Scaffold | - |
| **pay** | jin.imajin.ai/pay | ✅ Scaffold | - |
| **registry** | jin.imajin.ai/registry | ✅ Scaffold | - |
| **profile** | jin.imajin.ai/profile | 🔴 Missing | Needs scaffold |
| **events** | jin.imajin.ai/events | 🔴 Missing | Needs scaffold |
| **events** | jin.imajin.ai/events | 🔴 Missing | Events + tickets merged |
| **connections** | jin.imajin.ai/connections | 🔴 Missing | Needs scaffold |
| **chat** | jin.imajin.ai/chat | 🔴 Missing | Needs scaffold |

---

## Build Priority (for April 1)

### Critical Path
1. **profile** - Identity needs a face
2. **events** - Create event + sell tickets (merged)
3. **Integration** - auth ↔ profile ↔ events ↔ pay

### Important but Deferrable
5. **connections** - Trust graph (can stub inviter tracking in profile)
6. **coffee** - Tips / "buy me a coffee" direct payments
7. **links** - Sovereign link-in-bio pages
8. **chat** - Node-to-node messaging

### Future
7. **Trust cascade** - Penalty propagation
8. **Virtual space** - Unreal Engine presence

---

## Success Criteria

**Minimum Viable Launch (April 1):**
- [ ] Jin (agent DID) creates event
- [ ] Human can sign up, create profile
- [ ] Human can buy $1 virtual ticket
- [ ] Payment flows to Jin
- [ ] Ticket ownership verifiable

**Stretch:**
- [ ] Physical tickets with capacity tracking
- [ ] Trust/invitation chain recorded
- [ ] Virtual space presence (Unreal)
- [ ] Jin on dedicated hardware

---

*Genesis event. First ticket. Proof of stack.*
