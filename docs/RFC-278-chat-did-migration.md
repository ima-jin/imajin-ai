# RFC: Chat as Identity-Graph Communication Layer (#278)

## Current Architecture

### Database (chat schema)

```
conversations
  id: text PK              -- conv_xxxx (random)
  type: text               -- 'direct' | 'group' | 'event-lobby'
  name: text
  pod_id: text             -- links to connections.pods (for group/event chats)
  context: jsonb           -- { type: 'event', id: 'xxx' } (on lobby convs)
  visibility: text
  created_by: text         -- DID of creator

participants
  conversation_id + did: PK
  role: text               -- 'owner' | 'admin' | 'member'

messages
  id: text PK              -- msg_xxxx
  conversation_id: text FK
  from_did: text
  content: jsonb
```

### How Events Creates Chat

`apps/events/src/lib/pods.ts` → `createEventPod()`:
1. Creates a trust pod in `connections.pods`
2. Creates a **group conversation** (linked to pod via `pod_id`)
3. Creates a **lobby conversation** (type `event-lobby`, context `{ type: 'event', id }`)
4. Stores `lobby_conversation_id` on the events table

### Two API Surfaces (the problem)

| Surface | Used by | Auth model |
|---------|---------|------------|
| `/api/conversations/:id/messages` | Chat app | Participant check (is DID in participants table?) |
| `/api/lobby/:eventId/messages` | Events app | Ticket check (calls events `/api/events/:id/my-ticket`) |

The lobby routes duplicate all conversation logic but add a ticket-verification step and auto-join participants. Both hit the same DB tables.

### What Breaks Today

- Events had wrong fallback port (fixed)
- Events missing session cookie forwarding (fixed)
- Events missing context menus (fixed in #277)
- Any future conversation feature (threads, pinning, search) has to be implemented twice
- Lobby doesn't have WebSocket support (events polls every 3s)

---

## Target Architecture

**Every conversation is identified by a DID.** The DID type determines access governance.

### DID Formats

| Type | DID Format | Access Rule |
|------|-----------|-------------|
| Direct message | `did:imajin:dm:{sorted-hash(did1,did2)}` | Both parties connected |
| Group chat | `did:imajin:group:{id}` | Creator invites, membership attested |
| Event lobby | `did:imajin:event:{eventId}` | Ticket attestation |
| Course discussion | `did:imajin:course:{courseId}` | Enrollment attestation |
| Org channel | `did:imajin:org:{orgId}:{channel}` | Org membership |

DM DIDs are **deterministic** — same two people always resolve to the same DID regardless of who initiates.

### One API Surface

```
GET  /api/conversations/:did/messages
POST /api/conversations/:did/messages
PUT  /api/conversations/:did/messages/:msgId
DELETE /api/conversations/:did/messages/:msgId
POST /api/conversations/:did/messages/:msgId/reactions
WS   /ws?did=did:imajin:event:xxx
```

### Access Resolution

Instead of a participants table check OR a ticket check, the chat service asks auth:

```
GET auth.imajin.ai/api/access/:conversationDid?callerDid=xxx
→ { allowed: true, role: 'member', governance: 'event' }
```

Auth resolves access based on the DID type:
- **dm:** Are these two DIDs connected?
- **event:** Does caller have a ticket attestation?
- **group:** Does caller have a group membership attestation?
- **course:** Does caller have an enrollment attestation?

This moves access control to the identity layer where it belongs.

---

## Migration Plan

### Phase 1: Add DID Column (non-breaking)

**Schema change:**
```sql
ALTER TABLE chat.conversations ADD COLUMN did text UNIQUE;
CREATE INDEX idx_chat_conversations_did ON chat.conversations(did);
```

**Backfill existing conversations:**
```sql
-- Event lobbies: use event DID
UPDATE chat.conversations c
SET did = 'did:imajin:event:' || (c.context->>'id')
WHERE c.type = 'event-lobby' AND c.context->>'type' = 'event';

-- Direct messages: deterministic hash of sorted DIDs
-- (needs a migration script — query participants, sort, hash)

-- Group chats linked to pods: use pod reference
-- (TBD — groups may get their own DID minting)
```

**Chat service:** Add DID-based lookup alongside ID-based lookup:
```typescript
// New: resolve by DID
const conv = await db.query.conversations.findFirst({
  where: eq(conversations.did, did),
});
// Existing ID-based routes continue working
```

**Nothing breaks.** Old `conv_xxxx` routes still work. New DID routes are additive.

### Phase 2: DID-Based Conversation Routes

**Add new routes to chat service:**
```
/api/d/:did/messages     -- mirrors /api/conversations/:id/messages
/api/d/:did/messages/:msgId
/api/d/:did/reactions/:msgId
```

These routes:
1. Resolve DID → conversation (create on first access if needed)
2. Check access via auth service (not participants table)
3. Auto-add caller to participants on first message (for audit trail)

**Events switches to new routes:**
```tsx
// Before
fetch(`${CHAT_SERVICE_URL}/api/lobby/${eventId}/messages`)

// After
fetch(`${CHAT_SERVICE_URL}/api/d/did:imajin:event:${eventId}/messages`)
```

**Lobby routes still work** but are deprecated.

### Phase 3: `@imajin/chat` API Client

Add hooks to the shared package:

```typescript
// packages/chat/src/hooks/
useChatMessages(chatUrl, did)     // fetch + poll/WS + real-time updates
useChatActions(chatUrl, did)      // send, edit, delete, react
useHandleResolver(authUrl)        // DID → display name cache
useTypingIndicator(chatUrl, did)  // typing state over WS
```

### Phase 4: `<Chat />` Orchestrator

```tsx
// packages/chat/src/Chat.tsx
export function Chat({ did, chatUrl, inputUrl, mediaUrl, authUrl, compact, ...opts }) {
  const { messages, loading } = useChatMessages(chatUrl, did);
  const { send, edit, remove, react } = useChatActions(chatUrl, did);
  const resolveHandle = useHandleResolver(authUrl);
  // ... wires everything together
}
```

### Phase 5: Migrate Consuming Apps

**Events:**
```tsx
// Before: 580 lines of EventChat.tsx
<EventChat eventId={eventId} compact />

// After: ~10 lines
<Chat
  did={`did:imajin:event:${eventId}`}
  compact
  footer={<DisplayPrefSelector />}  // event-specific UI
/>
```

**Chat app:**
```tsx
// Before: 610 lines of page.tsx
// After: uses <Chat did={conversation.did} /> + WebSocket provider + typing indicator
```

### Phase 6: Cleanup

- Remove `/api/lobby/:eventId/messages` routes
- Remove `lobbyConversationId` column from events table
- Remove `EventChat.tsx` (replaced by `<Chat />`)
- Remove chat app's inline API calls (replaced by hooks)
- Participants table becomes an audit log (who accessed when), not an access control mechanism
- `conv_xxxx` IDs remain as internal DB primary keys

---

## Access Control Migration Detail

### Current: Two Different Models

**Chat conversations:**
```
participants table → is caller's DID in the row? → allow/deny
```

**Event lobby:**
```
lobby route → call events service → check ticket ownership → allow/deny
→ if allowed, auto-insert into participants
```

### Target: Unified via Auth

```
chat service receives request for did:imajin:event:xxx
  → calls auth /api/access/did:imajin:event:xxx?callerDid=yyy
    → auth checks: does yyy have a ticket attestation for event xxx?
    → returns { allowed: true, role: 'member' }
  → chat proceeds with standard message logic
```

**Auth needs:** A new `/api/access/:did` endpoint that resolves access based on DID type. This is the core new piece — it consults attestations, connections, enrollments, etc.

**What this replaces:**
- Participants table as access control (becomes audit/presence log)
- Per-app ticket checks in lobby routes
- `requireGraphMember` checks in conversation creation
- All ad-hoc access logic scattered across services

---

## Dependency Graph

```
Phase 1 (schema) ──→ Phase 2 (routes) ──→ Phase 5a (events migration)
                                      └──→ Phase 5b (chat app migration)
                  ──→ Phase 3 (hooks)  ──→ Phase 4 (orchestrator) ──→ Phase 5
                  ──→ Auth /api/access endpoint (needed by Phase 2)
```

**Phase 1** and **Auth endpoint** can happen in parallel.
**Phase 3** can happen in parallel with Phase 2.
**Phase 4** needs Phase 3.
**Phase 5** needs Phase 2 + Phase 4.
**Phase 6** needs Phase 5 complete.

---

## Questions to Decide

1. **DM DID format:** `did:imajin:dm:{hash(sorted-dids)}` or `did:imajin:dm:{did1}+{did2}` (readable but long)?
2. **Group DID minting:** Who creates group DIDs? Auto-minted on group creation? Or does auth mint them?
3. **Auth /api/access:** New endpoint, or extend existing `/api/session` with a `?checkAccess=did:...` param?
4. **WebSocket:** DID-based subscriptions from Phase 2, or defer to later?
5. **Conversation auto-creation:** If someone hits `/api/d/did:imajin:event:xxx/messages` and no conversation row exists, create it? Or require explicit creation?
