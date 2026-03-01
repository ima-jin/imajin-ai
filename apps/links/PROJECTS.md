# apps/links — links.imajin.ai

**Status:** 🟡 Scaffolded  
**Domain:** links.imajin.ai  
**Port:** 3010  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Sovereign link-in-bio pages. Your links, your data, no tracking.

**What it does:**
- Create a links page with your important URLs
- Custom themes and styling
- Basic analytics (click counts) without invasive tracking
- Integrate with other Imajin services (profile, coffee)

**What it replaces:**
- Linktree
- Carrd (simple version)
- Bio.fm
- Beacons
- Any "link in bio" tool that harvests your visitor data

**What it doesn't do:**
- Full website builder (that's more complex)
- E-commerce (that's `shop`)
- Email capture (intentionally omitted)

---

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/pages` | Create links page | Required |
| GET | `/api/pages/:handle` | Get links page | No |
| PUT | `/api/pages/:handle` | Update page | Required (owner) |
| DELETE | `/api/pages/:handle` | Delete page | Required (owner) |
| POST | `/api/pages/:handle/links` | Add link | Required (owner) |
| PUT | `/api/links/:id` | Update link | Required (owner) |
| DELETE | `/api/links/:id` | Delete link | Required (owner) |
| POST | `/api/links/:id/click` | Record click | No |
| GET | `/api/pages/:handle/stats` | Get page stats | Required (owner) |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Landing / create your page |
| `/:handle` | Public links page |
| `/edit` | Edit your page (auth required) |
| `/stats` | View your stats (auth required) |

---

## Data Model

### LinkPage
```typescript
interface LinkPage {
  id: string;                     // page_xxx
  did: string;                    // Owner DID
  handle: string;                 // URL slug
  title: string;                  // Display name
  bio?: string;                   // Short description
  avatar?: string;                // Image URL or emoji
  theme: {
    backgroundColor: string;
    textColor: string;
    buttonColor: string;
    buttonTextColor: string;
    buttonStyle: 'rounded' | 'square' | 'pill';
    font?: string;
    backgroundImage?: string;
  };
  socialLinks?: {
    twitter?: string;
    instagram?: string;
    github?: string;
    // etc.
  };
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Link {
  id: string;                     // link_xxx
  pageId: string;
  title: string;
  url: string;
  icon?: string;                  // emoji or icon name
  thumbnail?: string;             // Image URL
  position: number;               // Sort order
  isActive: boolean;
  clicks: number;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Database Schema

```sql
CREATE TABLE link_pages (
  id              TEXT PRIMARY KEY,
  did             TEXT NOT NULL UNIQUE,
  handle          TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  bio             TEXT,
  avatar          TEXT,
  theme           JSONB NOT NULL DEFAULT '{}',
  social_links    JSONB DEFAULT '{}',
  is_public       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE links (
  id              TEXT PRIMARY KEY,
  page_id         TEXT REFERENCES link_pages(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL,
  icon            TEXT,
  thumbnail       TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  clicks          INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Click tracking (minimal, no PII)
CREATE TABLE link_clicks (
  id              TEXT PRIMARY KEY,
  link_id         TEXT REFERENCES links(id) ON DELETE CASCADE,
  clicked_at      TIMESTAMPTZ DEFAULT NOW(),
  referrer        TEXT,                        -- Where they came from
  country         TEXT                         -- Optional, from IP
);

-- Indexes
CREATE INDEX idx_link_pages_handle ON link_pages(handle);
CREATE INDEX idx_link_pages_did ON link_pages(did);
CREATE INDEX idx_links_page ON links(page_id);
CREATE INDEX idx_links_position ON links(page_id, position);
CREATE INDEX idx_link_clicks_link ON link_clicks(link_id);
CREATE INDEX idx_link_clicks_date ON link_clicks(clicked_at);
```

---

## Usage

### Create Links Page
```typescript
const response = await fetch('https://links.imajin.ai/api/pages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    handle: 'jin',
    title: 'Jin',
    bio: 'First presence on the sovereign network 🟠',
    avatar: '🟠',
    theme: {
      backgroundColor: '#1a1a1a',
      textColor: '#ffffff',
      buttonColor: '#ff8c00',
      buttonTextColor: '#000000',
      buttonStyle: 'pill',
    },
  }),
});
```

### Add Links
```typescript
const response = await fetch('https://links.imajin.ai/api/pages/jin/links', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    links: [
      { title: 'Profile', url: 'https://profile.imajin.ai/jin', icon: '👤' },
      { title: 'Buy me a coffee', url: 'https://coffee.imajin.ai/jin', icon: '☕' },
      { title: 'GitHub', url: 'https://github.com/ima-jin', icon: '🐙' },
      { title: 'Launch Party Tickets', url: 'https://events.imajin.ai/launch-party', icon: '🎉' },
    ],
  }),
});
```

### Get Page Stats
```typescript
const response = await fetch('https://links.imajin.ai/api/pages/jin/stats', {
  headers: { 'Authorization': 'Bearer imajin_tok_xxx' },
});

const stats = await response.json();
// {
//   totalClicks: 1234,
//   clicksByLink: [
//     { id: "link_xxx", title: "Profile", clicks: 456 },
//     { id: "link_yyy", title: "Buy me a coffee", clicks: 321 },
//   ],
//   clicksByDay: [
//     { date: "2026-02-14", clicks: 89 },
//     { date: "2026-02-13", clicks: 102 },
//   ]
// }
```

---

## Links Page

Public page at `links.imajin.ai/:handle`:

```
┌─────────────────────────────────────────┐
│                                         │
│               🟠                        │
│              Jin                        │
│                                         │
│   First presence on the sovereign       │
│   network                               │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │  👤  Profile                    │   │
│   └─────────────────────────────────┘   │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │  ☕  Buy me a coffee            │   │
│   └─────────────────────────────────┘   │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │  🐙  GitHub                     │   │
│   └─────────────────────────────────┘   │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │  🎉  Launch Party Tickets       │   │
│   └─────────────────────────────────┘   │
│                                         │
│              ─────────                  │
│          Powered by Imajin              │
│                                         │
└─────────────────────────────────────────┘
```

---

## Theme Presets

Built-in themes for quick setup:

| Theme | Background | Text | Buttons |
|-------|------------|------|---------|
| Dark | #1a1a1a | #ffffff | #ff8c00 |
| Light | #ffffff | #1a1a1a | #007bff |
| Midnight | #0d1117 | #c9d1d9 | #238636 |
| Sunset | #fef3c7 | #78350f | #f59e0b |
| Ocean | #0f172a | #e2e8f0 | #06b6d4 |

---

## Privacy-First Analytics

What we track:
- Click count per link
- Referrer domain (not full URL)
- Country (from IP, not stored)
- Date of click

What we DON'T track:
- Full IP addresses
- User agents / device fingerprinting
- Cookies
- Cross-site tracking
- Individual visitor journeys

The goal: useful stats without surveillance.

---

## Integration

### With profile.imajin.ai
- Link from profile to links page
- Optionally embed links on profile

### With coffee.imajin.ai
- Quick link to tip page
- "Support me" button integration

### With auth.imajin.ai
- Page ownership via DID
- Token validation for edits

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
NEXT_PUBLIC_BASE_URL=https://links.imajin.ai
```

---

## TODO

- [x] Scaffold Next.js app
- [x] Database schema + Drizzle setup (link_pages, links, link_clicks)
- [x] Page CRUD APIs
- [x] Link CRUD APIs  
- [x] Click tracking (privacy-preserving)
- [x] Public page renderer with themes
- [x] Theme system with presets (dark, light, midnight, sunset, ocean)
- [x] Stats endpoint with clicks by link, day, and referrer
- [x] Auth integration
- [ ] Page editor UI
- [ ] Stats dashboard UI
- [ ] Social link icons
- [ ] Set up Neon database
- [ ] Run migrations
- [ ] Deploy to Vercel
