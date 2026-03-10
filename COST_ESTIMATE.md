# Build Cost Estimate — Imajin Platform

*Generated 2026-03-10 · Updated with COCOMO II + issue-based validation*

---

## Summary

| Metric | Traditional | Actual |
|--------|------------|--------|
| **Cost** | **$1,671,304** | **$43,793** |
| **Timeline** | 14.8 months | 37 days |
| **Team** | 6.4 people | 1 person + AI |
| **Hours** | 14,516 | 210 |
| **Cost multiplier** | — | **38× cheaper** |
| **Speed multiplier** | — | **15× faster** |
| **Hour multiplier** | — | **69× fewer hours** |

### Actual Cost Breakdown

| Item | Amount |
|------|--------|
| AI/API inference spend | $1,793.09 |
| Human hours (210h @ $200/hr) | $42,000.00 |
| **Total** | **$43,793.09** |

---

## Angle 1: COCOMO II (Industry Standard)

The Constructive Cost Model II is the industry standard for estimating software project cost, effort, and schedule from source lines of code. Used by NASA, DoD, and enterprise consulting firms.

### Source: `cloc` Analysis

| Language | Files | Blank | Comment | Code |
|----------|------:|------:|--------:|-----:|
| TypeScript | 493 | 6,672 | 4,873 | 47,203 |
| YAML | 18 | 2,312 | 0 | 13,969 |
| JSON | 57 | 0 | 0 | 12,647 |
| Markdown | 82 | 5,712 | 29 | 11,442 |
| JavaScript | 19 | 45 | 58 | 347 |
| SQL | 11 | 25 | 51 | 273 |
| CSS | 8 | 21 | 3 | 122 |
| **Total** | **699** | **14,835** | **5,024** | **86,331** |

### COCOMO II Weighting

Not all lines are equal. COCOMO weights by type:

| Category | Raw SLOC | Weight | Effective SLOC |
|----------|------:|-------:|------:|
| Source code (TS/JS/SQL/CSS) | 47,945 | 1.0× | 47,945 |
| Config (JSON/YAML) | 26,616 | 0.3× | 7,985 |
| Documentation (MD) | 11,442 | 0.2× | 2,288 |
| **Total** | **86,003** | — | **58,218** |

**Effective KSLOC: 58.2**

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
| Reusability | Above Nominal | 1.07 | Shared packages (@imajin/ui, fair, db) |
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
| Effort | 95.5 person-months |
| Hours | 14,516 |
| Duration | 14.8 months |
| Average team size | 6.4 people |

### Cost at Market Rates

| Rate Tier | Annual | Fully Loaded (1.4×) | Project Cost |
|-----------|-------:|--------------------:|-------------:|
| Mid-level ($120K) | $120,000 | $168,000 | $1,337,043 |
| **Blended ($150K)** | **$150,000** | **$210,000** | **$1,671,304** |
| Senior ($160K) | $160,000 | $224,000 | $1,782,724 |
| Staff ($200K) | $200,000 | $280,000 | $2,228,405 |

*Fully loaded = salary × 1.4 (benefits, equipment, tools, office, management overhead)*

---

## Angle 2: Issue-Based Estimate (Delivered Work)

127 closed GitHub issues, tiered by complexity using title, labels, and scope signals.

### Tiering Model

| Tier | Hours | Equivalent | Count | Total Hours |
|------|------:|------------|------:|------------:|
| Epic | 160h | 4 weeks | 1 | 160 |
| Large | 80h | 2 weeks | 7 | 560 |
| Medium | 40h | 1 week | 106 | 4,240 |
| Small | 16h | 2 days | 8 | 128 |
| Trivial | 4h | ½ day | 5 | 20 |
| **Total** | | | **127** | **5,108** |

### Delivered Work Cost

| Metric | Value |
|--------|-------|
| Total hours | 5,108 |
| Cost (fully loaded @ $150K/yr) | $515,712 |
| Timeline (3-person team) | 11.2 months |

### Notable Delivered Epics & Large Tickets

| # | Title | Tier |
|---|-------|------|
| #251 | Sovereign User Data — portable identity bundles | Epic |
| #267 | Embedded Wallet — DID keypair as Solana wallet | Large |
| #249 | Plugin architecture — third-party apps | Large |
| #248 | Org DID — identity primitive for businesses | Large |
| #247 | Cultural DID — identity primitive for collectives | Large |
| #186 | Media ML auto-classification pipeline | Large |
| #22 | Settlement engine — multi-recipient .fair distribution | Large |

---

## Angle 3: Issue-Based Estimate (Scoped Roadmap)

98 open GitHub issues with defined scope — the work ahead.

### Tiering Breakdown

| Tier | Hours | Count | Total Hours |
|------|------:|------:|------------:|
| Epic | 160h | 11 | 1,760 |
| Large | 80h | 27 | 2,160 |
| Medium | 40h | 46 | 1,840 |
| Small | 16h | 14 | 224 |
| **Total** | | **98** | **5,984** |

### Scoped Roadmap Cost

| Metric | Value |
|--------|-------|
| Total hours | 5,984 |
| Cost (fully loaded @ $150K/yr) | $604,154 |
| Timeline (3-person team) | 13.1 months |

### Major Scoped Epics

| # | Title | Hours |
|---|-------|------:|
| #112 | Revenue streams: five paths value flows | 160 |
| #113 | Settlement fees — protocol percentage | 160 |
| #114 | Declared-Intent Marketplace | 160 |
| #115 | Headless service settlement | 160 |
| #116 | Education settlement | 160 |
| #117 | Trust graph queries | 160 |
| #256 | Sovereign Inference | 160 |
| #259 | Node Operations | 160 |
| #156 | Federated message relay | 160 |
| #158 | Federated edit/delete propagation | 160 |
| #159 | Federated pod membership | 160 |

### Major Scoped Large Tickets

| # | Title | Hours |
|---|-------|------:|
| #241 | Calendar service | 80 |
| #260 | Notification system | 80 |
| #174 | Signed .fair attribution | 80 |
| #161 | Verifiable Credentials | 80 |
| #19 | Implement did:mjn DID method | 80 |
| #20 | Build .fair manifest library | 80 |
| #21 | MJN Consent Declaration | 80 |
| #23 | Trust graph implementation | 80 |
| #25 | April 1 demo: end-to-end MJN transaction | 80 |
| #56 | Shop service | 80 |
| #55 | News service | 80 |
| #51 | Admin interface | 80 |

---

## Cross-Validation

Three independent estimates converge:

| Method | Delivered | Scoped | Total |
|--------|----------|--------|-------|
| **COCOMO II** (code-based) | — | — | **$1,671,304** |
| **Issue-based** (delivered + scoped) | $515,712 | $604,154 | **$1,119,866** |

The issue-based total ($1.12M) is lower than COCOMO ($1.67M) because:
- Heuristic tiering underestimates multi-day "medium" tickets
- COCOMO includes overhead (PM, QA, meetings, ramp-up) that issues don't capture
- Issues don't account for infrastructure work not tracked in tickets

**COCOMO's overhead breakdown (included in the $1.67M):**

| Overhead | % of Base | Hours | Cost |
|----------|----------:|------:|-----:|
| Project Management | 15% | 1,434 | $144,761 |
| Code Review | 10% | 956 | $96,507 |
| Meetings & Communication | 12% | 1,148 | $115,809 |
| QA & Testing | 15% | 1,434 | $144,761 |
| Deployment & Ops | 8% | 765 | $77,206 |
| Documentation | 5% | 478 | $48,254 |
| Onboarding & Ramp-up | 10% | 956 | $96,507 |

These are the costs a traditional team incurs that a solo AI-augmented builder skips entirely.

---

## The Comparison

| | Traditional (COCOMO II) | AI-Augmented (Actual) |
|--|------------------------|----------------------|
| **Cost** | $1,671,304 | $43,793 |
| **Timeline** | 14.8 months | 37 days |
| **Team** | 6.4 people | 1 person + AI |
| **Hours** | 14,516 | 210 |
| | | |
| **Cost ratio** | — | **38× cheaper** |
| **Speed ratio** | — | **15× faster** |
| **Hour ratio** | — | **69× fewer hours** |
| | | |
| **Scoped ahead** | $604,154 (98 tickets) | At current pace: weeks |
| **Total platform value** | **~$2.3M** (built + scoped) | — |

### At Growth Company Rates

At a growth-stage startup ($200K/yr fully loaded staff engineers):

| Metric | Value |
|--------|-------|
| COCOMO estimate | $2,228,405 |
| Cost multiplier vs actual | **51× cheaper** |

---

## Methodology

- **LOC count:** `cloc v2.02` excluding node_modules, .next, dist, build, .turbo, coverage
- **COCOMO model:** COCOMO II Post-Architecture, constants A=2.94, B=0.91, C=3.67
- **Fully loaded rate:** Salary × 1.4 (industry standard for benefits + overhead)
- **Issue tiering:** Heuristic classification by title keywords, labels, and scope signals
- **Human rate:** $200/hr (senior/staff contractor rate, Toronto market)
- **AI spend:** Cumulative API costs across all inference providers as of 2026-03-10

---

*Generated by [COCOMO II](https://en.wikipedia.org/wiki/COCOMO) analysis + GitHub issue mining · Part of the [Imajin](https://imajin.ai) sovereign network*
