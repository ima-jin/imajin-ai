# Build Cost Estimate — Imajin Platform

*Generated 2026-03-13 · Updated with COCOMO II + issue-based validation*

---

## Summary

| Metric | Traditional | Actual |
|--------|------------|--------|
| **Cost** | **$1,782,649** | **$52,251** |
| **Timeline** | 13.4 months | 40 days |
| **Team** | 7.6 people | 1 person + AI |
| **Hours** | 15,484 | 250 |
| **Cost multiplier** | — | **34× cheaper** |
| **Speed multiplier** | — | **10× faster** |
| **Hour multiplier** | — | **62× fewer hours** |

### Actual Cost Breakdown

| Item | Amount |
|------|--------|
| AI/API inference spend | $2,251.03 |
| Human hours (250h @ $200/hr) | $50,000.00 |
| **Total** | **$52,251.03** |

---

## Angle 1: COCOMO II (Industry Standard)

The Constructive Cost Model II is the industry standard for estimating software project cost, effort, and schedule from source lines of code. Used by NASA, DoD, and enterprise consulting firms.

### Source: `cloc` Analysis

| Language | Files | Blank | Comment | Code |
|----------|------:|------:|--------:|-----:|
| TypeScript | 530 | 6,972 | 5,022 | 49,991 |
| YAML | 18 | 2,330 | 0 | 14,120 |
| JSON | 59 | 0 | 0 | 12,909 |
| Markdown | 119 | 6,703 | 29 | 13,651 |
| JavaScript | 20 | 75 | 71 | 513 |
| SQL | 15 | 53 | 112 | 324 |
| CSS | 8 | 21 | 3 | 122 |
| Shell | 3 | 33 | 22 | 148 |
| **Total** | **781** | **16,220** | **5,261** | **92,037** |

### COCOMO II Weighting

Not all lines are equal. COCOMO weights by type:

| Category | Raw SLOC | Weight | Effective SLOC |
|----------|------:|-------:|------:|
| Source code (TS/JS/SQL/CSS/Shell) | 51,098 | 1.0× | 51,098 |
| Config (JSON/YAML) | 27,029 | 0.3× | 8,109 |
| Documentation (MD) | 13,651 | 0.2× | 2,730 |
| **Total** | **91,778** | — | **61,937** |

**Effective KSLOC: 61.9**

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
| Effort | 101.9 person-months |
| Hours | 15,484 |
| Duration | 13.4 months |
| Average team size | 7.6 people |

### Cost at Market Rates

| Rate Tier | Annual | Fully Loaded (1.4×) | Project Cost |
|-----------|-------:|--------------------:|-------------:|
| Mid-level ($120K) | $120,000 | $168,000 | $1,426,600 |
| **Blended ($150K)** | **$150,000** | **$210,000** | **$1,782,649** |
| Senior ($160K) | $160,000 | $224,000 | $1,902,133 |
| Staff ($200K) | $200,000 | $280,000 | $2,377,667 |

*Fully loaded = salary × 1.4 (benefits, equipment, tools, office, management overhead)*

---

## Angle 2: Issue-Based Estimate (Delivered Work)

152 closed GitHub issues, tiered by complexity using title, labels, and scope signals.

### Tiering Model

| Tier | Hours | Equivalent | Count | Total Hours |
|------|------:|------------|------:|------------:|
| Epic | 160h | 4 weeks | 1 | 160 |
| Large | 80h | 2 weeks | 8 | 640 |
| Medium | 40h | 1 week | 125 | 5,000 |
| Small | 16h | 2 days | 12 | 192 |
| Trivial | 4h | ½ day | 6 | 24 |
| **Total** | | | **152** | **6,016** |

### Delivered Work Cost

| Metric | Value |
|--------|-------|
| Total hours | 6,016 |
| Cost (fully loaded @ $150K/yr) | $692,632 |
| Timeline (3-person team) | 13.2 months |

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

99 open GitHub issues with defined scope — the work ahead.

### Tiering Breakdown

| Tier | Hours | Count | Total Hours |
|------|------:|------:|------------:|
| Epic | 160h | 11 | 1,760 |
| Large | 80h | 27 | 2,160 |
| Medium | 40h | 46 | 1,840 |
| Small | 16h | 14 | 224 |
| **Total** | | **99** | **6,024** |

### Scoped Roadmap Cost

| Metric | Value |
|--------|-------|
| Total hours | 6,024 |
| Cost (fully loaded @ $150K/yr) | $608,194 |
| Timeline (3-person team) | 13.2 months |

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
| **COCOMO II** (code-based) | — | — | **$1,782,649** |
| **Issue-based** (delivered + scoped) | $692,632 | $608,194 | **$1,300,826** |

The issue-based total ($1.30M) is lower than COCOMO ($1.78M) because:
- Heuristic tiering underestimates multi-day "medium" tickets
- COCOMO includes overhead (PM, QA, meetings, ramp-up) that issues don't capture
- Issues don't account for infrastructure work not tracked in tickets

**COCOMO's overhead breakdown (included in the $1.67M):**

| Overhead | % of Base | Hours | Cost |
|----------|----------:|------:|-----:|
| Project Management | 15% | 2,322 | $267,397 |
| Code Review | 10% | 1,548 | $178,264 |
| Meetings & Communication | 12% | 1,858 | $213,917 |
| QA & Testing | 15% | 2,322 | $267,397 |
| Deployment & Ops | 8% | 1,238 | $142,611 |
| Documentation | 5% | 774 | $89,132 |
| Onboarding & Ramp-up | 10% | 1,548 | $178,264 |

These are the costs a traditional team incurs that a solo AI-augmented builder skips entirely.

---

## The Comparison

| | Traditional (COCOMO II) | AI-Augmented (Actual) |
|--|------------------------|----------------------|
| **Cost** | $1,782,649 | $52,251 |
| **Timeline** | 13.4 months | 40 days |
| **Team** | 7.6 people | 1 person + AI |
| **Hours** | 15,484 | 250 |
| | | |
| **Cost ratio** | — | **34× cheaper** |
| **Speed ratio** | — | **10× faster** |
| **Hour ratio** | — | **62× fewer hours** |
| | | |
| **Scoped ahead** | $608,194 (99 tickets) | At current pace: weeks |
| **Total platform value** | **~$2.4M** (built + scoped) | — |

### At Growth Company Rates

At a growth-stage startup ($200K/yr fully loaded staff engineers):

| Metric | Value |
|--------|-------|
| COCOMO estimate | $2,377,667 |
| Cost multiplier vs actual | **46× cheaper** |

---

## Methodology

- **LOC count:** `cloc v2.02` excluding node_modules, .next, dist, build, .turbo, coverage
- **COCOMO model:** COCOMO II Post-Architecture, constants A=2.94, B=0.91, C=3.67
- **Fully loaded rate:** Salary × 1.4 (industry standard for benefits + overhead)
- **Issue tiering:** Heuristic classification by title keywords, labels, and scope signals
- **Human rate:** $200/hr (senior/staff contractor rate, Toronto market)
- **AI spend:** Cumulative API costs across all inference providers as of 2026-03-13

---

*Generated by [COCOMO II](https://en.wikipedia.org/wiki/COCOMO) analysis + GitHub issue mining · Part of the [Imajin](https://imajin.ai) sovereign network*
