# Engineering Scratchpad (Living Notes)

This file is intentionally lightweight and regularly rewritten.

## Current snapshot

- Core app reliability work is focused on offline queue clarity, deterministic sync-state messaging, and safer date parsing.
- Security hardening completed recently includes stricter delete authorization checks, sanitized error messaging, safer logging behavior, and dependency updates.
- Web-admin and mobile now share stricter data contracts for dates and driver assignment payloads.

## Active watch list

1. **Offline stress testing:** prolonged bad-network sessions for replay/backlog behavior.
2. **Notification quality:** invalid token churn and fanout efficiency.
3. **Manifest reconciliation UX:** improve user confidence when server data wins conflicts.
4. **Docs freshness:** keep runbooks and contracts aligned with shipped behavior each sprint.

## Update discipline

When adding a note here:

- Include date and owning area (mobile/web-admin/functions).
- Move durable guidance into `docs/` once stabilized.
- Remove stale investigation notes after outcomes are documented elsewhere.

## 2026-03-12 - Hardening tour ID normalization (pre-TestFlight)
- I picked a reliability fix that eliminates subtle key drift between mobile and web-admin.
- `web-admin/src/services/tourService.js` previously generated IDs with only whitespace replacement, which could preserve lowercase and Firebase-invalid key chars (`.#$[]/`).
- This could produce duplicate-ish tours (`5112d_8` vs `5112D_8`) and invalid writes if operators pasted noisy codes.
- I updated `generateTourId` to:
  - trim + uppercase,
  - collapse whitespace to `_`,
  - strip Firebase-invalid key chars,
  - and safely fall back to random `TOUR_*` id if normalization empties the string.
- Added targeted tests to lock this behavior (`web-admin/src/services/tourService.test.js`).
- Why this one: it is tiny, high-leverage, and directly reduces production data-shape risk right before TestFlight.
