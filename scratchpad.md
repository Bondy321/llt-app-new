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
