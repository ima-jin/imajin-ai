# Build Cost Estimate — Imajin Platform

*Generated 2026-03-14 · Updated with COCOMO II + issue-based validation*

---

## Summary

| Metric | Traditional | Actual |
|--------|------------|--------|
| **Cost** | **$1,921,036** | **$59,600** |
| **Timeline** | 14.3 months | 42 days |
| **Team** | 7.8 people | 1 person + AI |
| **Hours** | 16,586 | 280 |
| **Cost multiplier** | — | **32× cheaper** |
| **Speed multiplier** | — | **10× faster** |
| **Hour multiplier** | — | **59× fewer hours** |

### Actual Cost Breakdown

| Item | Amount |
|------|--------|
| AI tokens consumed | 5,500,000 |
| AI/API inference spend | $3,600.00 |
| Human hours (280h @ $200/hr) | $56,000.00 |
| **Total** | **$59,600.00** |

### Token Efficiency

| Metric | Value |
|--------|-------|
| Tokens consumed | 5.5M |
| Lines of code produced | 97,267 |
| **Tokens per line of code** | **~57** |
| Issues closed | 168 |
| **Tokens per issue** | **~32,738** |
| Services shipped | 14 |
| **Tokens per service** | **~393K** |

5.5 million tokens is the raw computational effort — every architectural decision, code review, debug session, and refactor. At traditional rates, the equivalent human thinking time would be ~16,586 hours of senior engineering work.

---

## Angle 1: COCOMO II (Industry Standard)

The Constructive Cost Model II is the industry standard for estimating software project cost, effort, and schedule from source lines of code. Used by NASA, DoD, and enterprise consulting firms.

### Source: `cloc` Analysis

| Language | Files | Blank | Comment | Code |
|----------|------:|------:|--------:|-----:|
| TypeScript | 562 | 7,326 | 5,308 | 52,713 |
| YAML | 18 | 2,512 | 0 | 15,074 |
| Markdown | 126 | 7,276 | 35 | 15,095 |
| JSON | 61 | 0 | 0 | 12,986 |
| JavaScript | 20 | 75 | 71 | 513 |
| SQL | 20 | 54 | 115 | 357 |
| Shell | 3 | 33 | 22 | 148 |
| CSS | 8 | 21 | 3 | 122 |
| Other (SVG, XML, Text) | 9 | 33 | 2 | 259 |
| **Total** | **827** | **17,330** | **5,556** | **97,267** |

### COCOMO II Weighting

Not all lines are equal. COCOMO weights by type:

| Category | Raw SLOC | Weight | Effective SLOC |
|----------|------:|-------:|------:|
| Source code (TS/JS/SQL/CSS/Shell) | 53,853 | 1.0× | 53,853 |
| Config (JSON/YAML) | 28,060 | 0.3× | 8,418 |
| Documentation (MD) | 15,095 | 0.2× | 3,019 |
| **Total** | **97,008** | — | **65,290** |

**Effective KSLOC: 65.3**

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
| Reusability | Above Nominal | 1.07 | Shared packages (@imajin/ui, fair, db, chat, config, llm) |
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
| Effort | 109.2 person-months |
| Hours | 16,586 |
| Duration | 14.3 months |
| Average team size | 7.8 people |

### Cost at Market Rates

| Rate Tier | Annual | Fully Loaded (1.4×) | Project Cost |
|-----------|-------:|--------------------:|-------------:|
| Mid-level ($120K) | $120,000 | $168,000 | $1,536,829 |
| **Blended ($150K)** | **$150,000** | **$210,000** | **$1,921,036** |
| Senior ($160K) | $160,000 | $224,000 | $2,049,106 |
| Staff ($200K) | $200,000 | $280,000 | $2,561,382 |

*Fully loaded = salary × 1.4 (benefits, equipment, tools, office, management overhead)*

---

## Angle 2: Issue-Based Estimate (Delivered Work)

168 closed GitHub issues, tiered by complexity using title, labels, and scope signals.

### Tiering Model

| Tier | Hours | Equivalent | Count | Total Hours |
|------|------:|------------|------:|------------:|
| Epic | 160h | 4 weeks | 4 | 640 |
| Large | 80h | 2 weeks | 28 | 2,240 |
| Medium | 40h | 1 week | 124 | 4,960 |
| Small | 16h | 2 days | 11 | 176 |
| Trivial | 4h | ½ day | 1 | 4 |
| **Total** | | | **168** | **8,020** |

### Delivered Work Cost

| Metric | Value |
|--------|-------|
| Total hours | 8,020 |
| Cost (fully loaded @ $150K/yr) | $922,300 |
| Timeline (3-person team) | 19.1 months |

---

## Angle 3: Issue-Based Estimate (Scoped Roadmap)

99 open GitHub issues with defined scope — the work ahead.

### Tiering Breakdown

| Tier | Hours | Count | Total Hours |
|------|------:|------:|------------:|
| Epic | 160h | 18 | 2,880 |
| Large | 80h | 22 | 1,760 |
| Medium | 40h | 55 | 2,200 |
| Small | 16h | 4 | 64 |
| **Total** | | **99** | **6,904** |

### Scoped Roadmap Cost

| Metric | Value |
|--------|-------|
| Total hours | 6,904 |
| Cost (fully loaded @ $150K/yr) | $793,960 |
| Timeline (3-person team) | 16.4 months |

---

## Codebase Breakdown (Category Analysis)

From `cost_estimate.py` — files categorized by role, weighted by complexity and team mix:

| Category | Files | Lines | Hours | Cost |
|----------|------:|------:|------:|-----:|
| Frontend | 187 | 26,779 | 1,384 | $149,181 |
| Backend / API | 219 | 18,666 | 1,278 | $183,955 |
| Application Logic | 136 | 9,882 | 609 | $80,301 |
| Auth / Security | 44 | 3,308 | 384 | $66,193 |
| Infrastructure | 15 | 4,537 | 362 | $61,104 |
| Database / Schema | 71 | 3,149 | 253 | $41,464 |
| Documentation | 121 | 13,566 | 295 | $34,602 |
| Config / Build | 108 | 1,804 | 56 | $6,909 |
| **Subtotal** | **901** | **81,691** | **4,620** | **$623,711** |

### Traditional Overhead (included in COCOMO, broken out here)

| Overhead | % of Base | Hours | Cost |
|----------|----------:|------:|-----:|
| Project Management | 15% | 693 | $93,557 |
| QA & Testing | 15% | 693 | $93,557 |
| Meetings & Communication | 12% | 554 | $74,845 |
| Code Review | 10% | 462 | $62,371 |
| Onboarding & Ramp-up | 10% | 462 | $62,371 |
| Deployment & Ops | 8% | 370 | $49,897 |
| Documentation | 5% | 231 | $31,186 |
| **Total Overhead** | **75%** | **3,465** | **$467,783** |

These are the costs a traditional team incurs that a solo AI-augmented builder skips entirely.

---

## Cross-Validation

Three independent estimates converge:

| Method | Delivered | Scoped | Total |
|--------|----------|--------|-------|
| **COCOMO II** (code-based) | — | — | **$1,921,036** |
| **Issue-based** (delivered + scoped) | $922,300 | $793,960 | **$1,716,260** |

The issue-based total ($1.72M) is lower than COCOMO ($1.92M) because:
- Heuristic tiering underestimates multi-day "medium" tickets
- COCOMO includes overhead (PM, QA, meetings, ramp-up) that issues don't capture
- Issues don't account for infrastructure work not tracked in tickets

---

## The Comparison

| | Traditional (COCOMO II) | AI-Augmented (Actual) |
|--|------------------------|----------------------|
| **Cost** | $1,921,036 | $59,600 |
| **Timeline** | 14.3 months | 42 days |
| **Team** | 7.8 people | 1 person + AI |
| **Hours** | 16,586 | 280 |
| | | |
| **Cost ratio** | — | **32× cheaper** |
| **Speed ratio** | — | **10× faster** |
| **Hour ratio** | — | **59× fewer hours** |
| | | |
| **Scoped ahead** | $793,960 (99 tickets) | At current pace: weeks |
| **Total platform value** | **~$2.7M** (built + scoped) | — |

### At Growth Company Rates

At a growth-stage startup ($200K/yr fully loaded staff engineers):

| Metric | Value |
|--------|-------|
| COCOMO estimate | $2,561,382 |
| Cost multiplier vs actual | **43× cheaper** |

---

## What's Built (14 Services Live)

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
| input | input.imajin.ai | ✅ Live |
| learn | learn.imajin.ai | ✅ Live |
| coffee | coffee.imajin.ai | ✅ Live |
| dykil | dykil.imajin.ai | ✅ Live |
| links | links.imajin.ai | ✅ Live |

Plus 7 shared packages: `@imajin/db`, `@imajin/ui`, `@imajin/fair`, `@imajin/chat`, `@imajin/config`, `@imajin/auth`, `@imajin/llm`

---

## Methodology

- **LOC count:** `cloc v2.06` excluding node_modules, .next, dist, build, .turbo, coverage
- **COCOMO model:** COCOMO II Post-Architecture, constants A=2.94, B=0.91, C=3.67
- **Fully loaded rate:** Salary × 1.4 (industry standard for benefits + overhead)
- **Issue tiering:** Heuristic classification by title keywords, labels, and scope signals
- **Human rate:** $200/hr (senior/staff contractor rate, Toronto market)
- **AI spend:** Cumulative API costs across all inference providers as of 2026-03-14
- **Calendar days:** 42 (Feb 1 → Mar 14, 2026) — 32 days with commits

---

*Generated by [COCOMO II](https://en.wikipedia.org/wiki/COCOMO) analysis + GitHub issue mining · Part of the [Imajin](https://imajin.ai) sovereign network*
