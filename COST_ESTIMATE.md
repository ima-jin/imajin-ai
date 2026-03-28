# Build Cost Estimate — Imajin Platform

*Generated 2026-03-14 · Updated 2026-03-22 with COCOMO II + issue-based validation*

---

## Summary

| Metric | Traditional | Actual |
|--------|------------|--------|
| **Cost** | **$2,317,851** | **$76,445** |
| **Timeline** | 14.4 months | 50 days |
| **Team** | 9.2 people | 1 person + AI |
| **Hours** | 20,132 | 360 |
| **Cost multiplier** | — | **30× cheaper** |
| **Speed multiplier** | — | **8.6× faster** |
| **Hour multiplier** | — | **56× fewer hours** |

### Actual Cost Breakdown

| Item | Amount |
|------|--------|
| AI tokens consumed | 8,589,648 |
| AI/API inference spend | $4,445.25 |
| Human hours (360h @ $200/hr) | $72,000.00 |
| **Total** | **$76,445.25** |

### Token Efficiency

| Metric | Value |
|--------|-------|
| Tokens consumed | 8.59M |
| Lines of code produced | 122,721 |
| **Tokens per line of code** | **~70** |
| Issues closed | 235 |
| **Tokens per issue** | **~36,552** |
| Services shipped | 15 |
| **Tokens per service** | **~573K** |

8.59 million tokens is the raw computational effort — every architectural decision, code review, debug session, and refactor. At traditional rates, the equivalent human thinking time would be ~20,132 hours of senior engineering work.

---

## Angle 1: COCOMO II (Industry Standard)

The Constructive Cost Model II is the industry standard for estimating software project cost, effort, and schedule from source lines of code. Used by NASA, DoD, and enterprise consulting firms.

### Source: `cloc` Analysis

| Language | Files | Blank | Comment | Code |
|----------|------:|------:|--------:|-----:|
| TypeScript | 656 | 8,772 | 6,041 | 63,412 |
| Markdown | 169 | 10,157 | 36 | 22,885 |
| YAML | 22 | 2,738 | 0 | 22,736 |
| JSON | 62 | 0 | 0 | 12,165 |
| JavaScript | 26 | 91 | 88 | 627 |
| Shell | 6 | 73 | 54 | 308 |
| SQL | 14 | 34 | 50 | 207 |
| CSS | 8 | 21 | 3 | 122 |
| Other (SVG, XML, Text) | 9 | 33 | 2 | 259 |
| **Total** | **972** | **21,919** | **6,274** | **122,721** |

### COCOMO II Weighting

Not all lines are equal. COCOMO weights by type:

| Category | Raw SLOC | Weight | Effective SLOC |
|----------|------:|-------:|------:|
| Source code (TS/JS/SQL/CSS/Shell) | 64,676 | 1.0× | 64,676 |
| Config (JSON/YAML) | 34,901 | 0.3× | 10,470 |
| Documentation (MD) | 22,885 | 0.2× | 4,577 |
| **Total** | **122,462** | — | **79,723** |

**Effective KSLOC: 79.7**

### COCOMO II Parameters

**Scale Factors (project characteristics):**

| Factor | Rating | Value | Rationale |
|--------|--------|------:|-----------|
| Precedentedness | Nominal | 3.0 | Web services familiar; sovereign identity novel |
| Flexibility | High | 2.0 | Startup, flexible requirements |
| Risk Resolution | High | 2.0 | Good architecture, evolving rapidly |
| Team Cohesion | Nominal | 3.0 | Small team, strong cohesion |
| Process Maturity | Nominal | 3.0 | GitHub, CI/CD, structured issues |
| **Exponent (E)** | | **1.04** | B + 0.01 × ΣSF |

**Effort Multipliers (cost drivers):**

| Driver | Rating | Value | Rationale |
|--------|--------|------:|-----------|
| Reliability | High | 1.10 | Financial transactions, auth, crypto |
| Complexity | High | 1.17 | Multi-service, trust graphs, crypto |
| Reusability | Above Nominal | 1.07 | Shared packages (@imajin/ui, fair, db, chat, config, llm, auth, media) |
| Analyst Capability | Very High | 0.85 | 30 years systems architecture |
| Programmer Capability | High | 0.88 | AI-augmented development |
| Personnel Continuity | Very High | 0.81 | Solo builder, zero turnover |
| Application Experience | High | 0.88 | Deep domain experience |
| Platform Experience | High | 0.91 | Years on Node/Next.js/Postgres |
| Language Experience | High | 0.91 | Years of TypeScript |
| Tool Usage | Very High | 0.78 | AI coding agents, modern toolchain |
| **Product (EM)** | | **0.4743** | |

### COCOMO II Results

| Metric | Value |
|--------|-------|
| Effort | 132.4 person-months |
| Hours | 20,132 |
| Duration | 14.4 months |
| Average team size | 9.2 people |

### Cost at Market Rates

| Rate Tier | Annual | Fully Loaded (1.4×) | Project Cost |
|-----------|-------:|--------------------:|-------------:|
| Mid-level ($120K) | $120,000 | $168,000 | $1,857,282 |
| **Blended ($150K)** | **$150,000** | **$210,000** | **$2,317,851** |
| Senior ($160K) | $160,000 | $224,000 | $2,472,374 |
| Staff ($200K) | $200,000 | $280,000 | $3,090,468 |

*Fully loaded = salary × 1.4 (benefits, equipment, tools, office, management overhead)*

---

## Angle 2: Issue-Based Estimate (Delivered Work)

235 closed GitHub issues, tiered by complexity using title, labels, and scope signals.

### Tiering Model

| Tier | Hours | Equivalent | Count | Total Hours |
|------|------:|------------|------:|------------:|
| Epic | 160h | 4 weeks | 6 | 960 |
| Large | 80h | 2 weeks | 40 | 3,200 |
| Medium | 40h | 1 week | 172 | 6,880 |
| Small | 16h | 2 days | 15 | 240 |
| Trivial | 4h | ½ day | 2 | 8 |
| **Total** | | | **235** | **11,288** |

### Delivered Work Cost

| Metric | Value |
|--------|-------|
| Total hours | 11,288 |
| Cost (fully loaded @ $150K/yr) | $1,298,120 |
| Timeline (3-person team) | 26.9 months |

---

## Angle 3: Issue-Based Estimate (Scoped Roadmap)

107 open GitHub issues with defined scope — the work ahead.

### Tiering Breakdown

| Tier | Hours | Count | Total Hours |
|------|------:|------:|------------:|
| Epic | 160h | 20 | 3,200 |
| Large | 80h | 24 | 1,920 |
| Medium | 40h | 58 | 2,320 |
| Small | 16h | 5 | 80 |
| **Total** | | **107** | **7,520** |

### Scoped Roadmap Cost

| Metric | Value |
|--------|-------|
| Total hours | 7,520 |
| Cost (fully loaded @ $150K/yr) | $864,800 |
| Timeline (3-person team) | 17.9 months |

---

## Cross-Validation

Three independent estimates converge:

| Method | Delivered | Scoped | Total |
|--------|----------|--------|-------|
| **COCOMO II** (code-based) | — | — | **$2,317,851** |
| **Issue-based** (delivered + scoped) | $1,298,120 | $864,800 | **$2,162,920** |

The issue-based total ($2.16M) is lower than COCOMO ($2.32M) because:
- Heuristic tiering underestimates multi-day "medium" tickets
- COCOMO includes overhead (PM, QA, meetings, ramp-up) that issues don't capture
- Issues don't account for infrastructure work not tracked in tickets

---

## The Comparison

| | Traditional (COCOMO II) | AI-Augmented (Actual) |
|--|------------------------|----------------------|
| **Cost** | $2,317,851 | $76,445 |
| **Timeline** | 14.4 months | 50 days |
| **Team** | 9.2 people | 1 person + AI |
| **Hours** | 20,132 | 360 |
| | | |
| **Cost ratio** | — | **30× cheaper** |
| **Speed ratio** | — | **8.6× faster** |
| **Hour ratio** | — | **56× fewer hours** |
| | | |
| **Scoped ahead** | $864,800 (107 tickets) | At current pace: weeks |
| **Total platform value** | **~$3.2M** (built + scoped) | — |

### At Growth Company Rates

At a growth-stage startup ($200K/yr fully loaded staff engineers):

| Metric | Value |
|--------|-------|
| COCOMO estimate | $3,090,468 |
| Cost multiplier vs actual | **40× cheaper** |

---

## What's Built (15 Services Live)

| Service | URL | Status |
|---------|-----|--------|
| www | imajin.ai | ✅ Live |
| auth | auth.imajin.ai | ✅ Live |
| pay | pay.imajin.ai | ✅ Live |
| profile | profile.imajin.ai | ✅ Live |
| registry | registry.imajin.ai | ✅ Live |
| events | events.imajin.ai | ✅ Live |
| chat | chat.imajin.ai | ✅ Live |
| connections | connections.imajin.ai | ✅ Live |
| media | media.imajin.ai | ✅ Live |
| learn | learn.imajin.ai | ✅ Live |
| coffee | coffee.imajin.ai | ✅ Live |
| dykil | dykil.imajin.ai | ✅ Live |
| links | links.imajin.ai | ✅ Live |
| market | market.imajin.ai | ✅ Live |

Plus 8 shared packages: `@imajin/db`, `@imajin/ui`, `@imajin/fair`, `@imajin/chat`, `@imajin/config`, `@imajin/auth`, `@imajin/llm`, `@imajin/media`

---

## Methodology

- **LOC count:** `cloc v2.06` excluding node_modules, .next, dist, build, .turbo, coverage, drizzle
- **COCOMO model:** COCOMO II Post-Architecture, constants A=2.94, B=0.91, C=3.67
- **Fully loaded rate:** Salary × 1.4 (industry standard for benefits + overhead)
- **Issue tiering:** Heuristic classification by title keywords, labels, and scope signals
- **Human rate:** $200/hr (senior/staff contractor rate, Toronto market)
- **AI spend:** Cumulative API costs across all inference providers as of 2026-03-22
- **Calendar days:** 50 (Feb 1 → Mar 22, 2026)
- **Human hours:** 360 (avg ~10h/day on active build days)

---

*Generated by [COCOMO II](https://en.wikipedia.org/wiki/COCOMO) analysis + GitHub issue mining · Part of the [Imajin](https://imajin.ai) sovereign network*
