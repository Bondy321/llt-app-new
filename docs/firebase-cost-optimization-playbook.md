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

Web-admin implementation:

- `ToursManager` queries `tours` through indexed numeric `endDateEpochMs` windows and caps current, past, and all-dates views at 500 records. The UI discloses when a result is capped; capped totals and exports are not complete-archive totals.
- Dated tour creates and edits write UTC-midnight `startDateEpochMs` and `endDateEpochMs` alongside the display date fields. Before releasing this query path over legacy data, dry-run `npm --prefix functions run backfill:tour-date-indexes`, correct invalid records, then apply with `--apply --allow-full-scan`.
- `normalizeTourDateIndexes` and `normalizeTourEndDateIndex` are the server-owned repair boundary for every producer (web admin, management/Apps Script sync, and Admin SDK maintenance). They listen only to the two date leaves, avoiding invocations for unrelated high-volume location/participant/safety updates. Deploy the Functions first, run and verify the backfill, deploy the RTDB index/validation rules, and only then release the bounded web query. RTDB rules validate numeric ordering when fields are present; the server triggers are authoritative because parent-level admin writes and Admin SDK producers cannot be made field-required by child validation. Monitor for invalid dated tours whose stale indexes the Functions remove.
- Driver issue projections use a collision-free composite projection ID and `departurePriorityKey`, ordered unresolved critical first and newest within priority. Before releasing the new admin query, deploy Functions, dry-run then apply `npm --prefix functions run backfill:driver-tour-pack-issues -- --apply --allow-full-scan`, deploy the `departurePriorityKey` RTDB index, and then deploy web admin. Legacy issue-ID-only records are deleted only when their embedded departure/driver identity matches the source being migrated.
- Driver directory consumers share one bounded listener. Driver Tour Pack issues are queried only for visible departure keys, capped per departure, and coverage/operations calculations build lookup indexes once per snapshot.
- Notification legacy read-state retirement performs one keys-only shallow discovery to seed a private tour queue, then uses key-ordered 50-principal pages; it does not repeat full-tour principal enumeration every 15 minutes. Durable notice-eviction jobs use the same 50-principal continuation bound.

### 2) Push token + preference hygiene

- Continue token refresh on launch.
- Prune invalid Expo tokens quickly after failed deliveries.
- Skip fanout early when user preferences disable a notification class.
- Keep the tour feed at 100 notices, prune orphaned read-state when notices roll off, and query only the newest 50 notices / 100 read markers on mobile.
- Treat Expo ticket acceptance separately from future receipt-confirmed delivery metrics.

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
