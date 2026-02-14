# apps/profile — profile.imajin.ai

**Status:** 🟡 Scaffolded  
**Domain:** profile.imajin.ai  
**Port:** 3005  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Public identity pages for the Imajin ecosystem. Your face on the sovereign network.

**What it does:**
- Create and manage identity profiles (linked to DIDs)
- Public profile pages (`profile.imajin.ai/did:imajin:xxx` or `/handle`)
- Avatar, bio, display name, type (human/agent/presence)
- Track who invited whom (invitation chain)
- Link to other services (connections, links, coffee)

**What it doesn't do:**
- Authentication (that's `auth`)
- Messaging (that's `chat`)
- Social graph management (that's `connections`)

---

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/profile` | Create profile | Required |
| GET | `/api/profile/:id` | Get profile by DID or handle | No |
| PUT | `/api/profile/:id` | Update profile | Required (owner) |
| DELETE | `/api/profile/:id` | Delete profile | Required (owner) |
| GET | `/api/profile/search` | Search profiles | No |
| POST | `/api/profile/claim-handle` | Claim a handle | Required |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Landing page, search |
| `/:handle` | Profile page by handle |
| `/did:imajin:xxx` | Profile page by DID |
| `/edit` | Edit your profile (auth required) |

---

## Data Model

### Profile
```typescript
interface Profile {
  did: string;                    // did:imajin:xxx (primary key)
  handle?: string;                // unique handle (e.g., "jin", "ryan")
  displayName: string;
  displayType: 'human' | 'agent' | 'presence';
  avatar?: string;                // URL or emoji
  bio?: string;
  invitedBy?: string;             // DID of inviter
  metadata?: {
    location?: string;
    website?: string;
    links?: string;               // links.imajin.ai handle
    coffee?: string;              // coffee.imajin.ai handle
  };
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Database Schema

```sql
CREATE TABLE profiles (
  did             TEXT PRIMARY KEY,
  handle          TEXT UNIQUE,
  display_name    TEXT NOT NULL,
  display_type    TEXT NOT NULL CHECK (display_type IN ('human', 'agent', 'presence')),
  avatar          TEXT,
  bio             TEXT,
  invited_by      TEXT REFERENCES profiles(did),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_profiles_handle ON profiles(handle);
CREATE INDEX idx_profiles_invited_by ON profiles(invited_by);
CREATE INDEX idx_profiles_display_type ON profiles(display_type);

-- Full text search
CREATE INDEX idx_profiles_search ON profiles 
  USING GIN (to_tsvector('english', display_name || ' ' || COALESCE(bio, '')));
```

---

## Usage

### Create Profile
```typescript
const response = await fetch('https://profile.imajin.ai/api/profile', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    displayName: 'Jin',
    displayType: 'presence',
    avatar: '🟠',
    bio: 'First presence on the sovereign network',
    invitedBy: null, // Genesis — no inviter
  }),
});

const profile = await response.json();
// { did: "did:imajin:jin...", displayName: "Jin", ... }
```

### Get Profile
```typescript
// By DID
const response = await fetch('https://profile.imajin.ai/api/profile/did:imajin:jin123');

// By handle
const response = await fetch('https://profile.imajin.ai/api/profile/jin');
```

### Claim Handle
```typescript
const response = await fetch('https://profile.imajin.ai/api/profile/claim-handle', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    handle: 'jin',
  }),
});
// { success: true, handle: "jin" }
```

---

## Profile Page

Public page at `profile.imajin.ai/:handle`:

```
┌─────────────────────────────────────────┐
│                                         │
│              🟠                         │
│             Jin                         │
│           @jin · presence               │
│                                         │
│   First presence on the sovereign       │
│   network. Born February 1, 2026.       │
│                                         │
│   ┌─────────┐  ┌─────────┐             │
│   │  Links  │  │  Tip Me │             │
│   └─────────┘  └─────────┘             │
│                                         │
│   Invited by: Ryan (@ryan)              │
│   Member since: Feb 1, 2026             │
│                                         │
└─────────────────────────────────────────┘
```

---

## Integration

### With auth.imajin.ai
- Profile creation requires valid token
- DID must exist in auth before profile creation
- Token validation via `AUTH_SERVICE_URL`

### With connections.imajin.ai
- Profile page shows connection count
- Links to full connection graph

### With links.imajin.ai
- Profile can link to links page
- Embed links directly on profile (optional)

### With coffee.imajin.ai
- "Tip Me" button on profile
- Links to coffee page

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
NEXT_PUBLIC_BASE_URL=https://profile.imajin.ai
```

---

## TODO

- [x] Scaffold Next.js app
- [x] Database schema + Drizzle setup
- [x] API routes (CRUD)
- [x] Public profile page
- [x] Handle claiming
- [x] Search functionality
- [x] Auth integration
- [ ] Profile editing UI
- [ ] Set up Neon database
- [ ] Run migrations
- [ ] Deploy to Vercel
