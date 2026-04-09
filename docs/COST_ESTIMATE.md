# Build Cost Estimate — Imajin Platform

*Generated 2026-03-14 · Updated 2026-04-08 (Day 67) with current LOC, issues, and spend*

---

## Summary

| Metric | Traditional | Actual |
|--------|------------|--------|
| **Cost** | **$2,460,150** | **$107,940** |
| **Timeline** | 16.4 months | 67 days |
| **Team** | 8.6 people | 1 person + AI |
| **Hours** | 21,368 | 510 |
| **Cost multiplier** | — | **23× cheaper** |
| **Speed multiplier** | — | **7.4× faster** |
| **Hour multiplier** | — | **42× fewer hours** |

### Actual Cost Breakdown

| Item | Amount |
|------|--------|
| AI tokens consumed | 15,766,859 |
| AI/API inference spend | $5,939.75 |
| Human hours (510h @ $200/hr) | $102,000.00 |
| **Total** | **$107,939.75** |

### AI Spend by Month

| Month | Tokens | Spend |
|-------|-------:|------:|
| February | 2,823,029 | $1,101.65 |
| March | 10,684,829 | $4,194.97 |
| April (1–8) | 2,259,001 | $643.13 |
| **Total** | **15,766,859** | **$5,939.75** |

### Token Efficiency

| Metric | Value |
|--------|-------|
| Tokens consumed | 15.77M |
| Lines of code produced | 127,704 |
| **Tokens per line of code** | **~123** |
| Issues closed | 378 |
| **Tokens per issue** | **~41,711** |
| Services shipped | 15 |
| **Tokens per service** | **~1,051K** |

15.77 million tokens is the raw computational effort — every architectural decision, code review, debug session, and refactor. At traditional rates, the equivalent human thinking time would be ~21,368 hours of senior engineering work.

---

## Angle 1: COCOMO II (Industry Standard)

The Constructive Cost Model II is the industry standard for estimating software project cost, effort, and schedule from source lines of code. Used by NASA, DoD, and enterprise consulting firms.

### Source: `cloc` Analysis

| Language | Files | Blank | Comment | Code |
|----------|------:|------:|--------:|-----:|
| TypeScript | 716 | 9,891 | 6,873 | 73,253 |
| Markdown | 191 | 12,164 | 30 | 26,961 |
| YAML | 21 | 2,788 | 2 | 23,233 |
| Text | 4 | 426 | 0 | 1,454 |
| JSON | 49 | 0 | 0 | 1,352 |
| JavaScript | 18 | 111 | 94 | 782 |
| Shell | 8 | 99 | 78 | 419 |
| XML | 1 | 0 | 0 | 118 |
| CSS | 4 | 7 | 1 | 57 |
| SVG | 5 | 1 | 2 | 44 |
| SQL | 3 | 10 | 10 | 31 |
| **Total** | **1,020** | **25,497** | **7,090** | **127,704** |

*Note: Total LOC decreased from 131,997 (Day 57) despite adding 4,226 lines of TypeScript. The kernel merge (PR #631, -40,732 lines) consolidated 9 apps into 1, eliminating duplicate layouts, configs, and boilerplate. The codebase is more compact but delivers more functionality.*

### COCOMO II Weighting

Not all lines are equal. COCOMO weights by type:

| Category | Raw SLOC | Weight | Effective SLOC |
|----------|------:|-------:|------:|
| Source code (TS/JS/SQL/CSS/Shell) | 74,542 | 1.0× | 74,542 |
| Config (JSON/YAML) | 24,585 | 0.3× | 7,376 |
| Documentation (MD) | 26,961 | 0.2× | 5,392 |
| Other (Text/XML/SVG) | 1,616 | 0.1× | 162 |
| **Total** | **127,704** | — | **87,472** |

**Effective KSLOC: 87.5**

### COCOMO II Parameters

**Scale Factors (project characteristics):**

| Factor | Rating | Value | Rationale |
|--------|--------|------:|-----------|
| Precedentedness | Nominal | 3.0 | Web services familiar; sovereign identity novel |
| Flexibility | High | 2.0 | Startup, flexible requirements |
| Risk Resolution | Very High | 1.0 | RFC-19 kernel/userspace, 4 RFCs, clear architecture |
| Team Cohesion | Nominal | 3.0 | Small team, strong cohesion |
| Process Maturity | High | 2.0 | Migration CI checks, conformance tests, structured work orders |
| **Exponent (E)** | | **1.02** | B + 0.01 × ΣSF |

**Effort Multipliers (cost drivers):**

| Driver | Rating | Value | Rationale |
|--------|--------|------:|-----------|
| Reliability | High | 1.10 | Financial transactions, auth, crypto |
| Complexity | Very High | 1.34 | DFOS DAG chains, relay peering, federated auth, dual-token economics |
| Reusability | Above Nominal | 1.07 | Shared packages (@imajin/ui, fair, db, chat, config, llm, auth, media, notify, dfos) |
| Analyst Capability | Very High | 0.85 | 30 years systems architecture |
| Programmer Capability | High | 0.88 | AI-augmented development |
| Personnel Continuity | Very High | 0.81 | Solo builder, zero turnover |
| Application Experience | Very High | 0.81 | 67 days deep in domain, strong pattern library |
| Platform Experience | High | 0.91 | Years on Node/Next.js/Postgres |
| Language Experience | High | 0.91 | Years of TypeScript |
| Tool Usage | Very High | 0.78 | AI coding agents, modern toolchain |
| **Product (EM)** | | **0.5000** | |

### COCOMO II Results

| Metric | Value |
|--------|-------|
| Effort | 140.6 person-months |
| Hours | 21,368 |
| Duration | 16.4 months |
| Average team size | 8.6 people |

### Cost at Market Rates

| Rate Tier | Annual | Fully Loaded (1.4×) | Project Cost |
|-----------|-------:|--------------------:|-------------:|
| Mid-level ($120K) | $120,000 | $168,000 | $1,968,120 |
| **Blended ($150K)** | **$150,000** | **$210,000** | **$2,460,150** |
| Senior ($160K) | $160,000 | $224,000 | $2,624,190 |
| Staff ($200K) | $200,000 | $280,000 | $3,280,190 |

*Fully loaded = salary × 1.4 (benefits, equipment, tools, office, management overhead)*

---

## Angle 2: Issue-Based Estimate (Delivered Work)

378 closed GitHub issues, tiered by complexity using title, labels, and scope signals.

### Tiering Model

| Tier | Hours | Equivalent | Count | Total Hours |
|------|------:|------------|------:|------------:|
| Epic | 160h | 4 weeks | 9 | 1,440 |
| Large | 80h | 2 weeks | 65 | 5,200 |
| Medium | 40h | 1 week | 278 | 11,120 |
| Small | 16h | 2 days | 23 | 368 |
| Trivial | 4h | ½ day | 3 | 12 |
| **Total** | | | **378** | **18,140** |

### Delivered Work Cost

| Metric | Value |
|--------|-------|
| Total hours | 18,140 |
| Cost (fully loaded @ $150K/yr) | $2,086,100 |
| Timeline (3-person team) | 39.8 months |

---

## Angle 3: Issue-Based Estimate (Scoped Roadmap)

77 open GitHub issues with defined scope — the work ahead. Reduced from 130 after an issue cleanup: ~30 ice-boxed, remaining pruned for redundancy.

### Tiering Breakdown

| Tier | Hours | Count | Total Hours |
|------|------:|------:|------------:|
| Epic | 160h | 12 | 1,920 |
| Large | 80h | 18 | 1,440 |
| Medium | 40h | 40 | 1,600 |
| Small | 16h | 7 | 112 |
| **Total** | | **77** | **5,072** |

### Scoped Roadmap Cost

| Metric | Value |
|--------|-------|
| Total hours | 5,072 |
| Cost (fully loaded @ $150K/yr) | $583,280 |
| Timeline (3-person team) | 12.1 months |

---

## Cross-Validation

Three independent estimates converge:

| Method | Delivered | Scoped | Total |
|--------|----------|--------|-------|
| **COCOMO II** (code-based) | — | — | **$2,460,150** |
| **Issue-based** (delivered + scoped) | $2,086,100 | $583,280 | **$2,669,380** |

The issue-based total ($2.67M) runs slightly higher than COCOMO ($2.46M) because:
- The kernel merge consolidated code but the issues still represent the work done to build, test, and integrate each feature
- COCOMO measures code-in-repo; issue-based measures work-delivered including deleted/refactored code
- Growth-stage issues (epics #602, #615, #581) represent larger coordinated efforts than early medium tickets
- Both estimates exclude the 40,732 lines removed in the kernel merge that were written, tested, and shipped before consolidation

---

## The Comparison

| | Traditional (COCOMO II) | AI-Augmented (Actual) |
|--|------------------------|----------------------|
| **Cost** | $2,460,150 | $107,940 |
| **Timeline** | 16.4 months | 67 days |
| **Team** | 8.6 people | 1 person + AI |
| **Hours** | 21,368 | 510 |
| | | |
| **Cost ratio** | — | **23× cheaper** |
| **Speed ratio** | — | **7.4× faster** |
| **Hour ratio** | — | **42× fewer hours** |
| | | |
| **Scoped ahead** | $583,280 (77 tickets) | At current pace: weeks |
| **Total platform value** | **~$3.0M** (built + scoped) | — |

### At Growth Company Rates

At a growth-stage startup ($200K/yr fully loaded staff engineers):

| Metric | Value |
|--------|-------|
| COCOMO estimate | $3,280,190 |
| Cost multiplier vs actual | **30× cheaper** |

---

## What's Built (1 Kernel + 6 Federated Apps, 12 Shared Packages)

Kernel merge (Day 66–67): 9 core services consolidated into a single Next.js application. Userspace apps remain independent.

| Service | URL | Architecture |
|---------|-----|-------------|
| www | jin.imajin.ai | Kernel |
| auth | jin.imajin.ai/auth | Kernel |
| pay | jin.imajin.ai/pay | Kernel |
| profile | jin.imajin.ai/profile | Kernel |
| registry | jin.imajin.ai/registry | Kernel |
| chat | jin.imajin.ai/chat | Kernel |
| connections | jin.imajin.ai/connections | Kernel |
| media | jin.imajin.ai/media | Kernel |
| notify | jin.imajin.ai/notify | Kernel |
| events | jin.imajin.ai/events | Userspace |
| learn | jin.imajin.ai/learn | Userspace |
| coffee | jin.imajin.ai/coffee | Userspace |
| dykil | jin.imajin.ai/dykil | Userspace |
| links | jin.imajin.ai/links | Userspace |
| market | jin.imajin.ai/market | Userspace |

Shared packages: `@imajin/db`, `@imajin/ui`, `@imajin/fair`, `@imajin/chat`, `@imajin/config`, `@imajin/auth`, `@imajin/llm`, `@imajin/media`, `@imajin/notify`, `@imajin/dfos`, `@imajin/input`, `@imajin/trust-graph`

---

## Methodology

- **LOC count:** `cloc v1.98` excluding node_modules, .next, dist, build, .turbo, coverage, drizzle, .pnpm
- **COCOMO model:** COCOMO II Post-Architecture, constants A=2.94, B=0.91, C=3.67
- **Fully loaded rate:** Salary × 1.4 (industry standard for benefits + overhead)
- **Issue tiering:** Heuristic classification by title keywords, labels, and scope signals
- **Human rate:** $200/hr (senior/staff contractor rate, Toronto market)
- **AI spend:** Cumulative API costs across all inference providers, by month
- **Calendar days:** 67 (Feb 1 → Apr 8, 2026)
- **Days with commits:** 57
- **Human hours:** 510 (67 days minus rest days, ~8h/day average)

---

*Generated by [COCOMO II](https://en.wikipedia.org/wiki/COCOMO) analysis + GitHub issue mining · Part of the [Imajin](https://imajin.ai) sovereign network*
