# DYKIL — Don't You Know I'm Local

**Status:** 🟢 In Development  
**Domain:** dykil.imajin.ai → dontyouknowimlocal.com  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres (shared DB)

---

## Overview

Community economic sovereignty platform. Track where money leaks out of communities, make it visible, eventually match to local alternatives.

**Origin:** Ryan's 2002 DJ mix name, riff on "don't you know I'm loco?" — defiant energy for community economics.

---

## Requirements (2026-02-13)

### Auth / Signup
- **Avoid friction** — no signup required
- At end of form, optionally offer to email a code to tie response to email
- If declined: stored as anonymous stub, may be pruned if data looks sketchy
- Capture session data automatically (IP, headers) for quality scoring
- If adblocked/no data: store as orphan, lower quality but valid until proven otherwise

### Social Groups
- User can select **multiple** groups
- **Anyone can create** a group (creates on submit if doesn't exist)
- Show **member count** next to group name: `Toronto Friends (47)`
- Future: split contributions across groups, share link that pre-selects group

### Reporting / Display
- **For now:** just capture + summary
- After submit: show group totals only
  - Number of households
  - Total extraction by category
  - **No identifying info**, no specific cost details
- Very anonymous right now
- Data freshness handled later (maybe send reminders + group summary to email-verified users)

### Data Quality
- Nothing stops junk data — accept everything
- If we find junk, remove it manually
- Consider hardening options if it becomes an issue

### Local Alternatives
- **Local streaming DOES exist** — Plex, Jellyfin, Emby (self-hosted media servers)
- Gray area legally, but we live in gray areas
- Plex doesn't allow direct payment but hosts can be rewarded indirectly
- Local alternatives will surface as data reveals gaps
- Tools for local alternatives come later as engagement grows

### Geography
- **No postal code filtering** — accept all for now

---

## Data Model

### `dykil_groups`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | VARCHAR(255) | unique |
| created_at | TIMESTAMPTZ | |
| created_by_ip | VARCHAR(45) | for quality tracking |

### `dykil_submissions`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| created_at | TIMESTAMPTZ | |
| household_size | INT | 1-10 |
| postal_code | VARCHAR(20) | optional |
| email | VARCHAR(255) | optional, verified |
| email_verified | BOOLEAN | default false |
| verification_code | VARCHAR(10) | for email flow |
| session_ip | VARCHAR(45) | quality tracking |
| session_headers | JSONB | user-agent, etc |
| streaming | INT | $/month |
| rideshare | INT | |
| cloud | INT | |
| software | INT | |
| memberships | INT | |
| internet | INT | |
| utilities | INT | |
| rent | INT | |
| other | INT | |

### `dykil_submission_groups` (join)
| Column | Type |
|--------|------|
| id | UUID |
| submission_id | UUID FK |
| group_id | UUID FK |

---

## Spending Categories

| Emoji | Category | Examples |
|-------|----------|----------|
| 🎬 | Streaming | Netflix, Spotify, Disney+, Apple TV |
| 🚗 | Rideshare/Delivery | Uber, Lyft, DoorDash, Skip |
| ☁️ | Cloud/Storage | iCloud, Google One, Dropbox |
| 📱 | Software Subscriptions | Adobe, Microsoft 365, Notion |
| 🛒 | Memberships | Amazon Prime, Costco |
| 🌐 | Internet/Phone | Rogers, Bell, Telus |
| ⚡ | Utilities | Hydro, gas, heat |
| 🏦 | Rent/Mortgage | Monthly housing |
| 💳 | Other Recurring | Anything else |

---

## Architecture

```
apps/dykil/
├── app/
│   ├── page.tsx              # Landing + form
│   ├── layout.tsx
│   ├── globals.css
│   └── api/
│       ├── groups/route.ts   # GET list, POST create
│       └── submit/route.ts   # POST submission + return summary
├── src/
│   ├── db/
│   │   ├── schema.ts         # Drizzle schema
│   │   └── index.ts          # DB client
│   └── components/
│       └── SpendingForm.tsx  # Main form component
├── drizzle.config.ts
├── .env.local                # DATABASE_URL
└── PROJECTS.md               # This file
```

---

## Setup

```bash
# From monorepo root
pnpm install

# Push schema to Neon
pnpm --filter @imajin/dykil db:push

# Run dev (port 3002 by default)
PORT=3002 pnpm --filter @imajin/dykil dev
```

---

## TODO

- [x] Basic form with all categories
- [x] Group selection (multi-select + create)
- [x] Session tracking (IP, headers)
- [x] Summary view after submit (group totals only)
- [ ] Email verification flow (optional at end)
- [ ] Shareable group links (`?group=xyz` pre-selects)
- [ ] Rate limiting (basic IP-based)
- [ ] Admin view for junk cleanup
- [ ] Leaderboard page (communities ranked by participation)
- [ ] Email reminders + group summaries

---

## Notes

> "I became an activist after October 7th. And now I want to figure out how to rewire the entire substrate. Cut all of the extraction losers out entirely."

This is mutual aid infrastructure. Not charity — keeping money circulating locally.
