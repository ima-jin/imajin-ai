# FixReady — Appliance Pre-Registration & Repair Intake

**Status:** 🟡 Planning  
**Domain:** fixready.imajin.ai  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres  
**Client:** Rich Cooper (Consulting Project)

---

## Overview

FixReady is a **multi-tenant** appliance repair intake platform. Repair companies (Partners) give customers QR-coded magnets to stick on their appliances. When something breaks, the homeowner scans the QR code and completes a structured symptom intake — brand, model, symptoms, photos — and the repair company gets a job-ready summary *before* dispatching a technician.

**Design Principles:**
- No homeowner app — mobile web only
- No homeowner accounts required for MVP
- Integrate via job summary export (email/webhook/CSV) into existing dispatch systems
- Minimize technician behavior change
- Multi-tenant: one codebase serving many repair companies

**What FixReady does:**
- Pre-register appliances (type, brand, model, serial, location)
- Structured symptom intake with guided questions
- Media capture (photos/video of the problem)
- Rules-based part suggestions
- Job summary export to existing dispatch/CRM

**What FixReady doesn't do (MVP):**
- Scheduling
- Dispatch/CRM replacement
- Billing or payments
- Inventory management
- Real-time parts lookup (rules-based only)

---

## User Flows

### Flow A: Registration (First-Time Scan)
Homeowner scans QR on new magnet → Registers appliance → Done

```
A1 Landing (/go/{token})
    ↓
A2 Select Type (/go/{token}/type)
    ↓
A3 Identity (/go/{token}/identify)
    ↓
A4 Location (/go/{token}/location)
    ↓
A5 Success (/go/{token}/done)
```

### Flow B: Service Request (Return Scan)
Homeowner scans QR on registered appliance → Reports symptoms → Request submitted

```
B1 Recognized (/a/{appliance_id})
    ↓
B2 Symptoms (/a/{appliance_id}/symptoms)
    ↓
B3 Details (/a/{appliance_id}/details)
    ↓
B4 Submitted (/a/{appliance_id}/submitted)
```

### Flow D: Dispatcher/Ops (Desktop)
View incoming requests → Review details → Assign/Export

```
D1 Queue (/admin/requests)
    ↓
D2 Detail (/admin/requests/{id})
```

### Flow T: Technician
View assigned job on mobile

```
T1 Job Summary (/job/{job_id})
```

---

## Screen Specs

### A1 — Landing / Context
**Route:** `/go/{token}`  
**Persona:** Homeowner (mobile web)  
**Primary CTA:** Get Started

| Element | Notes |
|---------|-------|
| Partner logo/name | From PartnerCompany |
| Headline | "Prepare this appliance so repairs are faster when you need them" |
| 3 benefit bullets | Faster repair, fewer visits, arrive prepared |
| Primary CTA | "Get Started" |
| Microcopy | "No account required. Takes about 2 minutes." |

**Data created:** none (token lookup only)

---

### A2 — Select Appliance Type
**Route:** `/go/{token}/type`  
**Persona:** Homeowner

| Element | Notes |
|---------|-------|
| Type grid | Fridge, Dishwasher, Washer, Dryer, Oven/Range, HVAC, Other |
| Continue button | Disabled until selection |

**Data created:** `appliance_type`

---

### A3 — Appliance Identity
**Route:** `/go/{token}/identify`  
**Persona:** Homeowner

| Element | Notes |
|---------|-------|
| Brand | Typeahead from common brands |
| Model number | Text input |
| Serial number | Optional, text input |
| Age range | Dropdown: <5 years, 5-10 years, 10+ years |
| Help link | "Where to find model/serial" → modal with tips |
| Continue button | |

**Data created:** `brand`, `model`, `serial` (optional), `age_range`

---

### A4 — Location & Contact
**Route:** `/go/{token}/location`  
**Persona:** Homeowner

| Element | Notes |
|---------|-------|
| Address | Google Places autocomplete |
| Unit | Optional text |
| Room | Dropdown: Kitchen, Laundry, Basement, Garage, Other |
| Contact preference | Phone or Email input |
| Save Appliance button | |

**Data created:** `address`, `unit` (optional), `room`, `contact`

---

### A5 — Registered / Success
**Route:** `/go/{token}/done`  
**Persona:** Homeowner

| Element | Notes |
|---------|-------|
| Success state | Checkmark animation |
| Appliance summary card | Type, brand, model |
| Instruction | "Appliance registered. Leave the magnet on the appliance. Scan again if something goes wrong." |
| CTA: Done | Closes or redirects |
| Secondary CTA | "Register another appliance" → A2 |

**Data created:** `appliance_id` (system-generated)

---

### B1 — Appliance Recognized
**Route:** `/a/{appliance_id}`  
**Persona:** Homeowner (return scan)

| Element | Notes |
|---------|-------|
| Appliance summary | Type, brand, model, address |
| Address confirmation | "Is this still at 123 Main St?" |
| CTA | "What's going wrong?" |

**Data created:** none

---

### B2 — Symptom Category
**Route:** `/a/{appliance_id}/symptoms`  
**Persona:** Homeowner

| Element | Notes |
|---------|-------|
| Symptom list | 5-7 appliance-specific options from YAML |
| Continue button | Disabled until selection |

**Data created:** `symptom_category`

---

### B3 — Clarifiers + Media
**Route:** `/a/{appliance_id}/details`  
**Persona:** Homeowner

| Element | Notes |
|---------|-------|
| Clarifying questions | 2-4 dynamic questions based on symptom |
| Error code | Optional text input |
| Media upload | Photo/video, optional |
| CTA | "Request Repair" |

**Data created:** `symptom_details`, `media` (optional)

---

### B4 — Request Submitted
**Route:** `/a/{appliance_id}/submitted`  
**Persona:** Homeowner

| Element | Notes |
|---------|-------|
| Confirmation | "Request sent. Your service provider has what they need to prepare." |
| Reference ID | Display service_request_id |
| Response window | Partner-configurable message |
| Note | "They'll contact you shortly." |

**Data created:** `service_request_id`

---

### D1 — Requests Queue
**Route:** `/admin/requests`  
**Persona:** Dispatcher/Ops (desktop)

| Element | Notes |
|---------|-------|
| Table | Customer, appliance, issue summary, confidence, status |
| Filters | Status (new/assigned/closed), appliance type |
| Row click | → D2 detail view |

**Data created:** none (read-only)

---

### D2 — Request Detail
**Route:** `/admin/requests/{id}`  
**Persona:** Dispatcher/Ops

| Element | Notes |
|---------|-------|
| Appliance profile | Full details |
| Symptoms | Category + clarifier answers |
| Media | Gallery of uploaded photos/video |
| Suggested causes | Rules-based from YAML |
| Suggested parts kit | Rules-based from YAML |
| Confidence | Low/Medium/High indicator |
| Actions | Assign tech, Export summary, Email summary |

**Data created:** `assignment` (optional)

---

### T1 — Tech Job Summary
**Route:** `/job/{job_id}`  
**Persona:** Technician (mobile)

| Element | Notes |
|---------|-------|
| Appliance details | Type, brand, model, serial, age |
| Symptoms | Summary of what's wrong |
| Parts checklist | Suggested parts to bring |
| Address | Full address + access notes |
| Post-visit feedback | Optional quick form |

**Data created:** `post_visit_feedback` (optional)

---

## Architecture

```
apps/fixready/
├── app/
│   ├── page.tsx                      # Marketing landing (fixready.imajin.ai)
│   ├── layout.tsx
│   ├── globals.css
│   │
│   ├── go/
│   │   └── [token]/
│   │       ├── page.tsx              # A1: Landing
│   │       ├── type/page.tsx         # A2: Select type
│   │       ├── identify/page.tsx     # A3: Brand/model
│   │       ├── location/page.tsx     # A4: Address/contact
│   │       └── done/page.tsx         # A5: Success
│   │
│   ├── a/
│   │   └── [applianceId]/
│   │       ├── page.tsx              # B1: Recognized
│   │       ├── symptoms/page.tsx     # B2: Symptom category
│   │       ├── details/page.tsx      # B3: Clarifiers + media
│   │       └── submitted/page.tsx    # B4: Confirmation
│   │
│   ├── job/
│   │   └── [jobId]/
│   │       └── page.tsx              # T1: Tech job summary
│   │
│   ├── admin/
│   │   ├── layout.tsx                # Auth wrapper
│   │   ├── page.tsx                  # Dashboard redirect
│   │   ├── requests/
│   │   │   ├── page.tsx              # D1: Queue
│   │   │   └── [id]/page.tsx         # D2: Detail
│   │   ├── appliances/page.tsx       # Registered appliances list
│   │   ├── qr/page.tsx               # QR code generator
│   │   └── settings/page.tsx         # Partner settings
│   │
│   └── api/
│       ├── token/[token]/route.ts    # Validate token, get partner
│       ├── appliances/route.ts       # CRUD appliances
│       ├── requests/route.ts         # CRUD service requests
│       ├── requests/[id]/
│       │   ├── route.ts              # Get/update request
│       │   ├── assign/route.ts       # Assign technician
│       │   └── export/route.ts       # Generate job summary
│       ├── qr/generate/route.ts      # Generate QR codes
│       └── webhook/route.ts          # Outbound webhook
│
├── src/
│   ├── db/
│   │   ├── schema.ts                 # Drizzle schema
│   │   └── index.ts                  # DB connection
│   ├── lib/
│   │   ├── symptoms.ts               # Load symptom trees from YAML
│   │   ├── parts.ts                  # Rules-based part suggestions
│   │   ├── qr.ts                     # QR code generation
│   │   └── export.ts                 # Job summary formatting
│   └── components/
│       ├── appliance-card.tsx
│       ├── symptom-picker.tsx
│       ├── media-upload.tsx
│       └── ...
│
├── data/
│   └── symptoms/
│       ├── fridge.yaml
│       ├── washer.yaml
│       ├── dryer.yaml
│       ├── dishwasher.yaml
│       ├── oven.yaml
│       └── hvac.yaml
│
├── package.json
├── drizzle.config.ts
└── PROJECTS.md
```

---

## Database Schema

```sql
-- Partner Companies (tenants)
CREATE TABLE partners (
  id TEXT PRIMARY KEY,                      -- partner_xxx
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,                -- URL-safe identifier
  logo_url TEXT,
  contact_phone TEXT,
  contact_email TEXT NOT NULL,
  response_window_copy TEXT DEFAULT 'We''ll contact you within 24 hours',
  webhook_url TEXT,                         -- Optional outbound webhook
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Registration Tokens (for QR codes)
CREATE TABLE registration_tokens (
  id TEXT PRIMARY KEY,                      -- Short unique token
  partner_id TEXT REFERENCES partners(id) NOT NULL,
  label TEXT,                               -- Optional: "Batch #42", "Home Show 2026"
  scans INT DEFAULT 0,                      -- Track usage
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ                    -- Optional expiry
);

-- Appliances
CREATE TABLE appliances (
  id TEXT PRIMARY KEY,                      -- appliance_xxx
  partner_id TEXT REFERENCES partners(id) NOT NULL,
  token_id TEXT REFERENCES registration_tokens(id),
  type TEXT NOT NULL,                       -- fridge, washer, etc.
  brand TEXT,
  model TEXT,
  serial TEXT,
  age_range TEXT,                           -- <5, 5-10, 10+
  address TEXT NOT NULL,
  unit TEXT,
  room TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Service Requests
CREATE TABLE service_requests (
  id TEXT PRIMARY KEY,                      -- req_xxx
  appliance_id TEXT REFERENCES appliances(id) NOT NULL,
  symptom_category TEXT NOT NULL,
  symptom_details JSONB DEFAULT '{}',       -- Clarifier answers
  error_code TEXT,
  media_urls TEXT[],                        -- Array of uploaded media URLs
  confidence TEXT DEFAULT 'medium',         -- low, medium, high
  suggested_causes TEXT[],                  -- Rules-based
  suggested_parts TEXT[],                   -- Rules-based
  status TEXT DEFAULT 'new',                -- new, assigned, in_progress, closed
  assigned_to TEXT,                         -- Tech name/ID
  notes TEXT,                               -- Internal notes
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jobs (for tech view)
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                      -- job_xxx
  request_id TEXT REFERENCES service_requests(id) NOT NULL,
  tech_name TEXT,
  tech_phone TEXT,
  parts_checklist TEXT[],
  access_notes TEXT,
  post_visit_feedback JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_appliances_partner ON appliances(partner_id);
CREATE INDEX idx_appliances_token ON appliances(token_id);
CREATE INDEX idx_requests_appliance ON service_requests(appliance_id);
CREATE INDEX idx_requests_status ON service_requests(status);
CREATE INDEX idx_jobs_request ON jobs(request_id);
```

---

## Symptom Trees (YAML)

Symptoms are defined per appliance type in `data/symptoms/`. Example:

```yaml
# data/symptoms/washer.yaml
appliance_type: washer
symptoms:
  - id: not_draining
    label: "Won't drain / water stays in drum"
    clarifiers:
      - id: error_code
        question: "Is there an error code on the display?"
        type: text
        optional: true
      - id: noise
        question: "Do you hear any unusual noises?"
        type: select
        options:
          - "Humming"
          - "Grinding"
          - "Clicking"
          - "No unusual noise"
      - id: frequency
        question: "Does this happen every cycle?"
        type: select
        options:
          - "Every time"
          - "Sometimes"
          - "Just started"
    suggested_causes:
      - "Clogged drain pump"
      - "Blocked drain hose"
      - "Faulty lid switch"
    suggested_parts:
      - name: "Drain pump"
        confidence: high
      - name: "Drain hose"
        confidence: medium

  - id: not_spinning
    label: "Won't spin"
    clarifiers:
      - id: agitates
        question: "Does the agitator move?"
        type: select
        options:
          - "Yes, agitates but won't spin"
          - "No movement at all"
          - "Makes noise but doesn't move"
    suggested_causes:
      - "Worn drive belt"
      - "Motor coupling failure"
      - "Lid switch"
    suggested_parts:
      - name: "Drive belt"
        confidence: high
      - name: "Motor coupling"
        confidence: medium

  - id: leaking
    label: "Leaking water"
    clarifiers:
      - id: location
        question: "Where is the water coming from?"
        type: select
        options:
          - "Front"
          - "Back"
          - "Underneath"
          - "Not sure"
      - id: when
        question: "When does it leak?"
        type: select
        options:
          - "During fill"
          - "During wash"
          - "During spin"
          - "All the time"
    suggested_causes:
      - "Worn door seal"
      - "Loose hose connection"
      - "Cracked tub"
    suggested_parts:
      - name: "Door boot seal"
        confidence: high
      - name: "Inlet hose"
        confidence: medium

  - id: noisy
    label: "Making unusual noises"
    clarifiers:
      - id: noise_type
        question: "What kind of noise?"
        type: select
        options:
          - "Banging/thumping"
          - "Grinding"
          - "Squealing"
          - "Humming"
    suggested_causes:
      - "Unbalanced load"
      - "Worn drum bearings"
      - "Foreign object in drum"
    suggested_parts:
      - name: "Drum bearings"
        confidence: medium
      - name: "Shock absorbers"
        confidence: medium

  - id: wont_start
    label: "Won't start at all"
    clarifiers:
      - id: power
        question: "Do any lights come on?"
        type: select
        options:
          - "Yes, lights on but won't start"
          - "No lights, completely dead"
    suggested_causes:
      - "Door latch issue"
      - "Control board failure"
      - "Power supply"
    suggested_parts:
      - name: "Door latch assembly"
        confidence: medium
      - name: "Control board"
        confidence: low

  - id: other
    label: "Something else"
    clarifiers:
      - id: description
        question: "Please describe the problem"
        type: textarea
    suggested_causes: []
    suggested_parts: []
```

---

## QR Code Generation

Partners can generate QR codes from the admin panel.

### Single QR
Generate one QR code linking to `/go/{token}`.

### Batch QR
Generate multiple QR codes with labels (e.g., for direct mail campaigns).

### QR Content
```
https://fixready.imajin.ai/go/{token}
```

### Implementation
Use `qrcode` package to generate PNG/SVG. Store tokens in `registration_tokens` table for tracking scans.

```typescript
// src/lib/qr.ts
import QRCode from 'qrcode';

export async function generateQR(token: string): Promise<Buffer> {
  const url = `https://fixready.imajin.ai/go/${token}`;
  return QRCode.toBuffer(url, {
    type: 'png',
    width: 400,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}
```

---

## Integration Output

When a service request is submitted or exported, FixReady generates a job summary.

### Email (Required)
```
Subject: New Service Request: [Type] - [Brand] [Model]

Customer: Jane Smith
Contact: (555) 123-4567
Address: 123 Main St, Apt 4B, Toronto ON

APPLIANCE
Type: Washer
Brand: LG
Model: WM3500CW
Serial: 12345ABC
Age: 5-10 years

ISSUE
Category: Won't drain / water stays in drum
Error Code: OE
Details:
- Unusual noises: Humming
- Frequency: Every time

SUGGESTED PARTS (bring if available)
✓ Drain pump (high confidence)
○ Drain hose (medium confidence)

MEDIA
- Photo: https://fixready.imajin.ai/media/xxx.jpg

---
Submitted via FixReady
Reference: req_abc123
```

### Webhook (Optional)
```json
POST {partner.webhook_url}

{
  "event": "service_request.created",
  "request_id": "req_abc123",
  "customer": {
    "name": "Jane Smith",
    "phone": "(555) 123-4567",
    "email": null
  },
  "address": {
    "full": "123 Main St, Apt 4B, Toronto ON",
    "unit": "4B",
    "room": "Laundry"
  },
  "appliance": {
    "id": "appliance_xyz",
    "type": "washer",
    "brand": "LG",
    "model": "WM3500CW",
    "serial": "12345ABC",
    "age_range": "5-10"
  },
  "symptoms": {
    "category": "not_draining",
    "label": "Won't drain / water stays in drum",
    "error_code": "OE",
    "details": {
      "noise": "Humming",
      "frequency": "Every time"
    }
  },
  "media_urls": [
    "https://fixready.imajin.ai/media/xxx.jpg"
  ],
  "suggested_parts": [
    { "name": "Drain pump", "confidence": "high" },
    { "name": "Drain hose", "confidence": "medium" }
  ],
  "confidence": "high",
  "created_at": "2026-02-14T10:30:00Z"
}
```

### CSV Export (Optional)
Available from admin panel for batch download.

---

## Copy Blocks

| Use | Text |
|-----|------|
| Landing headline | Prepare this appliance so repairs are faster when you need them. |
| Landing subtext | Register once. When something goes wrong, your service provider can prepare before arriving. |
| Landing microcopy | No account required. Takes about 2 minutes. |
| Registration helper | Tip: Look for a label inside the door, behind a panel, or near the power connection. |
| Success message | Appliance registered. Leave the magnet on the appliance. Scan again if something goes wrong. |
| Issue prompt | What's going wrong? |
| Submitted message | Request sent. Your service provider has what they need to prepare. They'll contact you shortly. |

---

## Multi-Tenancy

Each Partner is a tenant with:
- Isolated data (appliances, requests)
- Custom branding (logo, company name)
- Configurable response window messaging
- Separate QR code pools
- Optional webhook endpoint

### Admin Auth (MVP)
Simple email-based magic link for partner admins. No passwords.

### Future: Imajin Auth Integration
Partners could authenticate via auth.imajin.ai for full sovereign identity.

---

## TODO

### Phase 1: Core Flow
- [ ] Set up Vercel project + Neon DB
- [ ] Database schema + Drizzle setup
- [ ] Registration flow (A1-A5)
- [ ] Service request flow (B1-B4)
- [ ] Email job summary on submit
- [ ] Basic admin queue (D1-D2)

### Phase 2: QR + Branding
- [ ] QR code generation (single + batch)
- [ ] Partner branding on landing page
- [ ] QR scan tracking

### Phase 3: Tech + Export
- [ ] Tech job view (T1)
- [ ] Webhook integration
- [ ] CSV export
- [ ] Post-visit feedback

### Phase 4: Polish
- [ ] Symptom YAML files for all appliance types
- [ ] Media upload (S3/R2)
- [ ] Mobile optimization
- [ ] Partner onboarding flow

---

## Notes

> Rich Cooper is pitching this to appliance repair companies as a customer service improvement program. The goal is "ready-to-test" — something a repair company can pilot with minimal setup.

Key insight: FixReady **improves what happens before dispatch** without replacing anything the company already uses. It's additive, not replacement. That's the pitch.

The direct mail piece Rich is designing will include a QR-coded magnet. Homeowners stick it on their fridge/washer/etc. When something breaks, they scan → intake → the tech arrives prepared with the right parts.

🔧
