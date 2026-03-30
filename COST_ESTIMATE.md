# Build Cost Estimate — Imajin Platform

*Generated 2026-03-14 · Updated 2026-03-30 with COCOMO II + issue-based validation*

---

## Summary

| Metric | Traditional | Actual |
|--------|------------|--------|
| **Cost** | **$2,510,947** | **$93,237** |
| **Timeline** | 16.8 months | 57 days |
| **Team** | 8.6 people | 1 person + AI |
| **Hours** | 21,809 | 440 |
| **Cost multiplier** | — | **27× cheaper** |
| **Speed multiplier** | — | **9× faster** |
| **Hour multiplier** | — | **50× fewer hours** |

### Actual Cost Breakdown

| Item | Amount |
|------|--------|
| AI tokens consumed | 10,509,741 |
| AI/API inference spend | $5,237.27 |
| Human hours (440h @ $200/hr) | $88,000.00 |
| **Total** | **$93,237.27** |

### Token Efficiency

| Metric | Value |
|--------|-------|
| Tokens consumed | 10.51M |
| Lines of code produced | 131,997 |
| **Tokens per line of code** | **~80** |
| Issues closed | 257 |
| **Tokens per issue** | **~40,894** |
| Services shipped | 15 |
| **Tokens per service** | **~701K** |

10.51 million tokens is the raw computational effort — every architectural decision, code review, debug session, and refactor. At traditional rates, the equivalent human thinking time would be ~21,809 hours of senior engineering work.

---

## Angle 1: COCOMO II (Industry Standard)

The Constructive Cost Model II is the industry standard for estimating software project cost, effort, and schedule from source lines of code. Used by NASA, DoD, and enterprise consulting firms.

### Source: `cloc` Analysis

| Language | Files | Blank | Comment | Code |
|----------|------:|------:|--------:|-----:|
| TypeScript | 699 | 9,489 | 6,456 | 69,027 |
| Markdown | 184 | 11,132 | 30 | 25,127 |
| YAML | 22 | 2,755 | 2 | 22,563 |
| JSON | 64 | 0 | 0 | 12,211 |
| JavaScript | 28 | 100 | 99 | 701 |
| Shell | 8 | 97 | 71 | 407 |
| SQL | 15 | 38 | 56 | 226 |
| CSS | 7 | 20 | 4 | 119 |
| Other (SVG, XML, Text) | 10 | 427 | 2 | 1,616 |
| **Total** | **1,037** | **24,058** | **6,720** | **131,997** |

### COCOMO II Weighting

Not all lines are equal. COCOMO weights by type:

| Category | Raw SLOC | Weight | Effective SLOC |
|----------|------:|-------:|------:|
| Source code (TS/JS/SQL/CSS/Shell) | 70,480 | 1.0× | 70,480 |
| Config (JSON/YAML) | 34,774 | 0.3× | 10,432 |
| Documentation (MD) | 25,127 | 0.2× | 5,025 |
| Other (Text/XML/SVG) | 1,616 | 0.1× | 162 |
| **Total** | **131,997** | — | **86,099** |

**Effective KSLOC: 86.1**

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
| Effort | 143.5 person-months |
| Hours | 21,809 |
| Duration | 16.8 months |
| Average team size | 8.6 people |

### Cost at Market Rates

| Rate Tier | Annual | Fully Loaded (1.4×) | Project Cost |
|-----------|-------:|--------------------:|-------------:|
| Mid-level ($120K) | $120,000 | $168,000 | $2,008,758 |
| **Blended ($150K)** | **$150,000** | **$210,000** | **$2,510,947** |
| Senior ($160K) | $160,000 | $224,000 | $2,678,344 |
| Staff ($200K) | $200,000 | $280,000 | $3,347,930 |

*Fully loaded = salary × 1.4 (benefits, equipment, tools, office, management overhead)*

---

## Angle 2: Issue-Based Estimate (Delivered Work)

257 closed GitHub issues, tiered by complexity using title, labels, and scope signals.

### Tiering Model

| Tier | Hours | Equivalent | Count | Total Hours |
|------|------:|------------|------:|------------:|
| Epic | 160h | 4 weeks | 6 | 960 |
| Large | 80h | 2 weeks | 44 | 3,520 |
| Medium | 40h | 1 week | 189 | 7,560 |
| Small | 16h | 2 days | 16 | 256 |
| Trivial | 4h | ½ day | 2 | 8 |
| **Total** | | | **257** | **12,304** |

### Delivered Work Cost

| Metric | Value |
|--------|-------|
| Total hours | 12,304 |
| Cost (fully loaded @ $150K/yr) | $1,414,960 |
| Timeline (3-person team) | 29.3 months |

---

## Angle 3: Issue-Based Estimate (Scoped Roadmap)

130 open GitHub issues with defined scope — the work ahead.

### Tiering Breakdown

| Tier | Hours | Count | Total Hours |
|------|------:|------:|------------:|
| Epic | 160h | 24 | 3,840 |
| Large | 80h | 29 | 2,320 |
| Medium | 40h | 70 | 2,800 |
| Small | 16h | 7 | 112 |
| **Total** | | **130** | **9,072** |

### Scoped Roadmap Cost

| Metric | Value |
|--------|-------|
| Total hours | 9,072 |
| Cost (fully loaded @ $150K/yr) | $1,043,280 |
| Timeline (3-person team) | 21.6 months |

---

## Cross-Validation

Three independent estimates converge:

| Method | Delivered | Scoped | Total |
|--------|----------|--------|-------|
| **COCOMO II** (code-based) | — | — | **$2,510,947** |
| **Issue-based** (delivered + scoped) | $1,414,960 | $1,043,280 | **$2,458,240** |

The issue-based total ($2.46M) is lower than COCOMO ($2.51M) because:
- Heuristic tiering underestimates multi-day "medium" tickets
- COCOMO includes overhead (PM, QA, meetings, ramp-up) that issues don't capture
- Issues don't account for infrastructure work not tracked in tickets

---

## The Comparison

| | Traditional (COCOMO II) | AI-Augmented (Actual) |
|--|------------------------|----------------------|
| **Cost** | $2,510,947 | $93,237 |
| **Timeline** | 16.8 months | 57 days |
| **Team** | 8.6 people | 1 person + AI |
| **Hours** | 21,809 | 440 |
| | | |
| **Cost ratio** | — | **27× cheaper** |
| **Speed ratio** | — | **9× faster** |
| **Hour ratio** | — | **50× fewer hours** |
| | | |
| **Scoped ahead** | $1,043,280 (130 tickets) | At current pace: weeks |
| **Total platform value** | **~$3.6M** (built + scoped) | — |

### At Growth Company Rates

At a growth-stage startup ($200K/yr fully loaded staff engineers):

| Metric | Value |
|--------|-------|
| COCOMO estimate | $3,347,930 |
| Cost multiplier vs actual | **36× cheaper** |

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
| notify | notify.imajin.ai | ✅ Live |
| learn | learn.imajin.ai | ✅ Live |
| coffee | coffee.imajin.ai | ✅ Live |
| dykil | dykil.imajin.ai | ✅ Live |
| links | links.imajin.ai | ✅ Live |
| market | market.imajin.ai | ✅ Live |

Plus 11 shared packages: `@imajin/db`, `@imajin/ui`, `@imajin/fair`, `@imajin/chat`, `@imajin/config`, `@imajin/auth`, `@imajin/llm`, `@imajin/media`, `@imajin/notify`, `@imajin/dfos`, `@imajin/input`

---

## Methodology

- **LOC count:** `cloc v2.06` excluding node_modules, .next, dist, build, .turbo, coverage, drizzle
- **COCOMO model:** COCOMO II Post-Architecture, constants A=2.94, B=0.91, C=3.67
- **Fully loaded rate:** Salary × 1.4 (industry standard for benefits + overhead)
- **Issue tiering:** Heuristic classification by title keywords, labels, and scope signals
- **Human rate:** $200/hr (senior/staff contractor rate, Toronto market)
- **AI spend:** Cumulative API costs across all inference providers as of 2026-03-30
- **Calendar days:** 57 (Feb 1 → Mar 30, 2026)
- **Human hours:** 440 (total days minus 13 rest days × 10h/day)

---

*Generated by [COCOMO II](https://en.wikipedia.org/wiki/COCOMO) analysis + GitHub issue mining · Part of the [Imajin](https://imajin.ai) sovereign network*
