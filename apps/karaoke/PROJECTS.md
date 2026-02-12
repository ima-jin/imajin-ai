# Karaoke — Turn Management System

**Status:** 🟡 Planning  
**Domain:** karaoke.imajin.ai  
**Stack:** Next.js 14, Tailwind, Postgres, WebSocket (or Supabase Realtime)

---

## Overview

A real-time turn management system for karaoke nights. Two synced views:

- **Crowd Display** (`/{event}`) — iPad-facing, shows queue, sign-up at bottom
- **Host Admin** (`/{event}/admin`) — Phone-friendly, manages turns and event details

Generic enough to work for any turn-based queue (open mic, demos, etc).

---

## User Flows

### 1. Event Discovery (Root Page)
- List of active/upcoming events
- `+ ADD EVENT` button opens creation form
- Past/expired events hidden (or archived section)

### 2. Event Creation
| Field | Required | Notes |
|-------|----------|-------|
| Name | ✅ | Event title |
| Start Time | ✅ | No past times allowed |
| End Time | ❌ | Optional, helps auto-archive |
| Location | ❌ | Display only |

- Creates unique URL slug from name (e.g., `/friday-karaoke-feb-12`)
- Creator gets admin access (stored in localStorage or simple code)

### 3. Participant Sign-up (`/{event}`)
- See full queue (scroll required — intentional)
- `+ SIGN UP` button at top → jumps to bottom input
- Enter name → submit → success animation → auto-scroll to top
- No auth required, just name entry

### 4. Host Admin (`/{event}/admin`)
- Protected by simple code (set at event creation) or localStorage
- See queue with action buttons per participant:
  - ✅ **Complete** — marks turn done, records end time
  - ❌ **Not Present** — skipped, grayed differently
- Edit event details
- Real-time sync to crowd display

### 5. Real-time Sync
- When host marks a turn complete → crowd display updates instantly
- Options: Supabase Realtime, WebSocket, or polling fallback
- Crowd display is read-only, no refresh needed

---

## Database Schema

**Naming convention:** `imajin_ai_karaoke_{table}`

### `imajin_ai_karaoke_events`
```sql
CREATE TABLE imajin_ai_karaoke_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          VARCHAR(255) UNIQUE NOT NULL,
  name          VARCHAR(255) NOT NULL,
  location      VARCHAR(255),
  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Events "archive" naturally by filtering start_time < now() in queries
CREATE INDEX idx_events_start ON imajin_ai_karaoke_events(start_time);
CREATE INDEX idx_events_slug ON imajin_ai_karaoke_events(slug);
```

### `imajin_ai_karaoke_participants`
```sql
CREATE TABLE imajin_ai_karaoke_participants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID REFERENCES imajin_ai_karaoke_events(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  position      INTEGER NOT NULL,  -- queue order
  status        VARCHAR(20) DEFAULT 'waiting',  -- waiting | active | complete | skipped
  phone         VARCHAR(20),  -- v2: for SMS notifications
  turn_start    TIMESTAMPTZ,  -- when they started singing
  turn_end      TIMESTAMPTZ,  -- when marked complete
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_participants_event ON imajin_ai_karaoke_participants(event_id);
CREATE INDEX idx_participants_position ON imajin_ai_karaoke_participants(event_id, position);
```

### Computed Fields (app-level)
- `turn_duration` = `turn_end - turn_start` (displayed as "3m 42s")

---

## Pages & Routes

| Route | View | Description |
|-------|------|-------------|
| `/` | Public | Events list + ADD EVENT |
| `/[slug]` | Public | Crowd display — queue + sign-up |
| `/[slug]/admin` | Protected | Host controls — manage turns |

---

## Components

### Shared
- `EventCard` — event preview for list
- `ParticipantRow` — name + status + duration (if complete)
- `SignupForm` — name input at bottom of queue
- `EventForm` — create/edit event modal

### Crowd Display (`/[slug]`)
- Header: event name, location, start time
- `+ SIGN UP` button (jumps to bottom)
- Queue list (scroll to see all)
- Sign-up form at bottom
- Auto-scroll to top after sign-up

### Admin (`/[slug]/admin`)
- Same header + edit button
- Queue list with action buttons
- Mark complete / not present
- Shows turn duration for completed

---

## Phases

### Phase 1: MVP 🎯
Core functionality, get it working.

- [ ] **Database**
  - [ ] Set up Postgres connection (Supabase or direct)
  - [ ] Create tables with migrations
  - [ ] Seed script for testing

- [ ] **Events List (`/`)**
  - [ ] Fetch and display active/upcoming events (filter out past)
  - [ ] `+ ADD EVENT` button → modal form
  - [ ] Create event (name, start_time required)
  - [ ] Generate slug from name

- [ ] **Crowd Display (`/[slug]`)**
  - [ ] Fetch event + participants
  - [ ] Display queue (waiting first, then completed grayed)
  - [ ] `+ SIGN UP` button → scroll to bottom
  - [ ] Sign-up form → add to queue → animation → scroll to top
  - [ ] Auto-refresh or realtime subscription

- [ ] **Admin (`/[slug]/admin`)**
  - [ ] Mark participant complete (records turn_end)
  - [ ] Mark participant not present (status = skipped)
  - [ ] Display turn duration for completed
  - [ ] Edit event details
  - [ ] Real-time sync (multiple admins can be on same page)

- [ ] **Real-time Sync**
  - [ ] Polling (every 3s) for both crowd display and admin view
  - [ ] SWR or React Query for smart refetching

### Phase 1.1: Polish
UX improvements after MVP works.

- [ ] Better animations (Framer Motion)
- [ ] Sound effect on new sign-up (for host)
- [ ] "Now singing" highlight for active participant
- [ ] Estimated wait time display
- [ ] Mobile-optimized admin controls
- [ ] Event archival (auto-archive after end_time + 2h)
- [ ] Shareable event link / QR code

### Phase 2: Notifications
SMS integration for turn alerts.

- [ ] Capture phone number (optional) on sign-up
- [ ] Twilio/SMS integration
- [ ] Send "You're up in ~3 turns" notification
- [ ] Send "You're next!" notification
- [ ] Admin toggle to enable/disable SMS per event

### Phase 3: Analytics & Features
Nice-to-haves.

- [ ] Event history / past events view
- [ ] Average turn duration stats
- [ ] Repeat participant tracking
- [ ] Song request field (optional)
- [ ] Duet support (multiple names per turn)

---

## Tech Decisions

### Real-time Strategy
**Decision:** Polling at 3s interval. Karaoke turns don't need sub-second latency. Use SWR or React Query for smart cache invalidation and refetching.

### Auth
**MVP:** No auth at all.
- Anyone can access `/[slug]/admin` and manage any event
- Harden later if abuse becomes an issue
- Participants need no auth (just name entry)

### Slug Generation
- Lowercase, hyphenated from event name
- Append random suffix if collision: `friday-karaoke-a3x9`

---

## API Routes

### Events
- `GET /api/events` — list active/upcoming events (filters out past)
- `POST /api/events` — create event
- `GET /api/events/[slug]` — get event + participants
- `PATCH /api/events/[slug]` — update event

### Participants
- `POST /api/events/[slug]/participants` — sign up
- `PATCH /api/events/[slug]/participants/[id]` — update status

---

## Notes

- The "scroll past everyone" UX is intentional — participants should see the queue before signing up
- Keep it simple: no accounts, no complex auth, no song database
- This is a turn management system that happens to be for karaoke
- Could easily rebrand for open mic, customer queue, demo day, etc.

---

## Decisions Made

1. **Database:** Direct Postgres (already have it) + polling for real-time
2. **Admin auth:** None for MVP — `/admin` is open, harden later if abused
3. **Event expiry:** Natural — just filter `start_time >= now()` in queries, old events stay in DB
4. **Multiple admins:** Yes — concurrent access to `/admin` is fine, real-time sync keeps everyone updated

---

*Last updated: 2026-02-12*
