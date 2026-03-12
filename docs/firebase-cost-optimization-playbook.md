# Firebase Cost Optimization Playbook (Execution)

Last refreshed: February 2026.

This is the implementation runbook for reducing Firebase spend without user-facing regressions.

## Scope

Applies to:

- Realtime Database read/write volume.
- Cloud Functions invocation/runtime behavior.
- Push notification fanout hygiene.
- Storage growth + egress.

## Guardrails

1. No UX regression for passenger or driver workflows.
2. Measure before/after every shipped optimization.
3. Keep region consistency (`europe-west1`) for backend changes.
4. Roll out in small, reversible batches.

## Baseline instrumentation requirements

Track minimum 7 days before major tuning:

- Realtime DB reads/writes by path family:
  - `chats/*`, `internal_chats/*`
  - `tour_manifests/*`, `tours/*`
  - `users/*`
  - `group_tour_photos/*`, `private_tour_photos/*`
- Cloud Functions:
  - invocations, duration p50/p95, cold start ratio, memory tier.
- Notifications:
  - fanout recipients/event,
  - valid token ratio,
  - invalid token cleanup rate.
- Storage:
  - object count growth,
  - size growth,
  - egress/day.

## Priority optimization tracks

### 1) Listener scope tightening

- Ensure list screens subscribe only to current-tour branches.
- Remove stale listeners on screen exit/unmount.
- Replace broad root listeners with targeted child listeners where possible.

**Success metric:** measurable reduction in chat/manifest read volume per active user.

### 2) Push token + preference hygiene

- Continue token refresh on launch.
- Prune invalid Expo tokens quickly after failed deliveries.
- Skip fanout early when user preferences disable a notification class.

**Success metric:** lower wasted push attempts + higher valid delivery ratio.

### 3) Offline queue replay efficiency

- Keep replay FIFO + single-run lock to avoid duplicate writes.
- Retry only failed actions, not full queue, when user taps retry-failed.
- Preserve processed action IDs across restart.

**Success metric:** fewer duplicate writes during intermittent connectivity.

### 4) Storage lifecycle policy

- Define retention strategy for stale/duplicate photo assets.
- Favor compressed upload paths where quality allows.
- Audit orphaned metadata/object pairs.

**Success metric:** reduced monthly storage growth and egress.

## Change management checklist

For each shipped optimization:

- [ ] Baseline metric snapshot captured.
- [ ] Feature flag or rollback plan documented.
- [ ] Before/after dashboard comparison attached.
- [ ] QA validates no behavior regression.
- [ ] Post-release monitoring window completed.

## Reporting cadence

- Weekly: top 3 cost drivers and trend direction.
- Sprint-end: shipped optimizations + measured delta.
- Monthly: next-round targets prioritized by impact/effort.
