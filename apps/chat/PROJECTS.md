# apps/chat — chat.imajin.ai

**Status:** 🔴 Not Started  
**Domain:** chat.imajin.ai  
**Port:** 3011  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres, WebSockets

---

## Overview

Messaging between identities on the sovereign network. End-to-end encrypted. No data mining.

**What it does:**
- Direct messages between DIDs
- Group conversations
- End-to-end encryption (E2EE)
- Real-time delivery via WebSockets
- Offline message queue

**What it doesn't do:**
- Social posting / feed (different app)
- Voice/video calls (future maybe)
- Channels / servers (that's more like Discord)

---

## Endpoints

### REST API

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/conversations` | List conversations | Required |
| POST | `/api/conversations` | Create conversation | Required |
| GET | `/api/conversations/:id` | Get conversation details | Required |
| GET | `/api/conversations/:id/messages` | Get messages | Required |
| POST | `/api/conversations/:id/messages` | Send message | Required |
| DELETE | `/api/messages/:id` | Delete message | Required |
| PUT | `/api/conversations/:id/read` | Mark as read | Required |
| GET | `/api/keys/:did` | Get public key for E2EE | No |

### WebSocket

| Event | Direction | Description |
|-------|-----------|-------------|
| `connect` | → server | Authenticate connection |
| `message` | ← server | New message received |
| `typing` | ↔ | Typing indicator |
| `read` | ↔ | Read receipt |
| `presence` | ← server | Online/offline status |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Landing / inbox |
| `/c/:id` | Conversation view |
| `/new` | Start new conversation |
| `/settings` | Chat settings |

---

## Data Model

### Conversation
```typescript
interface Conversation {
  id: string;                     // conv_xxx
  type: 'direct' | 'group';
  name?: string;                  // For groups
  participants: string[];         // DIDs
  createdBy: string;              // DID
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt?: Date;
}

interface Message {
  id: string;                     // msg_xxx
  conversationId: string;
  fromDid: string;
  content: {
    encrypted: string;            // E2EE payload
    nonce: string;                // For decryption
  };
  replyTo?: string;               // Message ID
  status: 'sent' | 'delivered' | 'read';
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
}

interface Participant {
  conversationId: string;
  did: string;
  joinedAt: Date;
  lastReadAt?: Date;
  role: 'member' | 'admin';
  muted: boolean;
}

// For E2EE key exchange
interface PublicKeyBundle {
  did: string;
  identityKey: string;            // Long-term identity key
  preKeys: string[];              // One-time pre-keys
  signedPreKey: string;           // Signed pre-key
  signature: string;              // Signature of signed pre-key
}
```

---

## Database Schema

```sql
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  name            TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ
);

CREATE TABLE participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  did             TEXT NOT NULL,
  joined_at       TIMESTAMPTZ DEFAULT NOW(),
  last_read_at    TIMESTAMPTZ,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  muted           BOOLEAN DEFAULT false,
  PRIMARY KEY (conversation_id, did)
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  from_did        TEXT NOT NULL,
  content         JSONB NOT NULL,           -- { encrypted, nonce }
  reply_to        TEXT REFERENCES messages(id),
  status          TEXT NOT NULL DEFAULT 'sent',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ
);

-- For E2EE key exchange
CREATE TABLE public_keys (
  did             TEXT PRIMARY KEY,
  identity_key    TEXT NOT NULL,
  signed_pre_key  TEXT NOT NULL,
  signature       TEXT NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pre_keys (
  id              TEXT PRIMARY KEY,
  did             TEXT REFERENCES public_keys(did) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  used            BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_participants_did ON participants(did);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created ON messages(created_at DESC);
CREATE INDEX idx_pre_keys_did ON pre_keys(did) WHERE NOT used;
```

---

## End-to-End Encryption

Using Signal Protocol concepts (simplified):

### Key Exchange
1. Each user uploads public key bundle on registration
2. To start conversation, fetch recipient's keys
3. Perform X3DH key agreement
4. Derive shared secret for message encryption

### Message Encryption
1. Messages encrypted with XChaCha20-Poly1305
2. Each message uses unique nonce
3. Server only sees encrypted blobs
4. Only participants can decrypt

### Libraries
- `@noble/ciphers` — XChaCha20-Poly1305
- `@noble/curves` — X25519 key exchange
- `@noble/hashes` — Key derivation

---

## Usage

### Start Conversation
```typescript
const response = await fetch('https://chat.imajin.ai/api/conversations', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    type: 'direct',
    participants: ['did:imajin:recipient123'],
  }),
});

const { id, conversation } = await response.json();
```

### Send Message
```typescript
// Client-side: encrypt message before sending
const encrypted = await encryptMessage(plaintext, sharedSecret);

const response = await fetch(`https://chat.imajin.ai/api/conversations/${convId}/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    content: {
      encrypted: encrypted.ciphertext,
      nonce: encrypted.nonce,
    },
  }),
});
```

### WebSocket Connection
```typescript
const ws = new WebSocket('wss://chat.imajin.ai/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'connect',
    token: 'imajin_tok_xxx',
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === 'message') {
    const plaintext = await decryptMessage(msg.content, sharedSecret);
    // Display message
  }
};
```

---

## Chat UI

Conversation view at `chat.imajin.ai/c/:id`:

```
┌─────────────────────────────────────────┐
│  ← Back         Ryan          ●  Online │
├─────────────────────────────────────────┤
│                                         │
│                    Hey! How's the       │
│                    launch party prep?   │
│                              2:30 PM ✓✓ │
│                                         │
│  Going well! Just finished              │
│  the ticket service.                    │
│  2:32 PM                                │
│                                         │
│                    Nice! Can't wait     │
│                    to see it live 🎉    │
│                              2:33 PM ✓✓ │
│                                         │
├─────────────────────────────────────────┤
│  [Message...]                    [Send] │
└─────────────────────────────────────────┘
```

---

## Real-Time Features

### Typing Indicators
```typescript
// Send typing status
ws.send(JSON.stringify({
  type: 'typing',
  conversationId: 'conv_xxx',
  isTyping: true,
}));

// Receive typing status
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'typing') {
    // Show "Ryan is typing..."
  }
};
```

### Read Receipts
```typescript
// Mark as read
await fetch(`https://chat.imajin.ai/api/conversations/${convId}/read`, {
  method: 'PUT',
  headers: { 'Authorization': 'Bearer imajin_tok_xxx' },
});

// Receive read receipt
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'read') {
    // Update message status to ✓✓
  }
};
```

### Presence
```typescript
// Receive presence updates
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'presence') {
    // { did: "...", status: "online" | "offline", lastSeen: "..." }
  }
};
```

---

## Integration

### With auth.imajin.ai
- All endpoints require valid token
- Public keys linked to DIDs

### With profile.imajin.ai
- Display names and avatars in conversation
- Link to profiles

### With connections.imajin.ai
- Suggest conversations based on connections
- Optional: only allow messages from connections

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
PROFILE_SERVICE_URL=https://profile.imajin.ai
REDIS_URL=redis://...                     # For WebSocket pub/sub
NEXT_PUBLIC_BASE_URL=https://chat.imajin.ai
NEXT_PUBLIC_WS_URL=wss://chat.imajin.ai
```

---

## Security Considerations

1. **E2EE**: Server never sees plaintext
2. **Forward secrecy**: Compromise of long-term key doesn't expose past messages
3. **Key verification**: Users can verify keys out-of-band
4. **Message retention**: Messages can be set to auto-delete
5. **No metadata logging**: Minimize stored metadata

---

## TODO

- [ ] Scaffold Next.js app
- [ ] Database schema + Drizzle setup
- [ ] REST API routes
- [ ] WebSocket server setup
- [ ] E2EE implementation
- [ ] Key exchange flow
- [ ] Conversation list UI
- [ ] Chat view UI
- [ ] Typing indicators
- [ ] Read receipts
- [ ] Presence system
- [ ] Push notifications (future)
- [ ] Group chat support
