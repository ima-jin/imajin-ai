# C18 — April 1 Demo Blockers — RESOLVED

**Filed:** March 27, 2026
**Resolved:** March 30, 2026
**Upstream HEAD:** a3260d1c

## Summary of Resolution

All critical April 1 demo blockers have been addressed:

| Blocker | Resolution | PRs/Commits |
|---------|-----------|-------------|
| MFA / secure login | Email MFA, password login, TOTP, device tracking | #432, #493, #519, #524, #528 |
| PBKDF2 iteration mismatch | Setup (100000) and login (310000) aligned | d65cad73 |
| Password login decryption | Base64 (not hex) decoding fixed | ea05b02e |
| Ticket scanner | QR scanner on event admin dashboard | #500 |
| Attestation coverage | 19 types emitting across 8 services | #461 |
| Notification system | Notify service + UI bell + toasts + @mentions | #479 |
| DFOS relay | 0.6.0 conformance + sequencer loop | #518, #527, #531 |
| Settlement wiring | `settleTicketPurchase()` in events webhook | apps/events/src/lib/settle.ts |
| Auth bridge to DFOS | Genesis on register, lazy backfill on login | #532 |

### Remaining Post-Demo Items
- Founding supporter tier (#474) — bridge to fundraise, not a demo blocker
- Issue triage (~119 → ~60 target) — cognitive overhead reduction
- `.fair` template wiring to all upload paths (P9)

### Original Concern
Three explicit blockers on issue #25 plus auth/MFA/DFOS gaps identified in the March 27 audit. All addressed in Ryan's March 28-30 sprint (32+ commits).
