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
- Dated tour creates and edits write UTC-midnight `startDateEpochMs` and `endDateEpochMs` alongside the display date fields. The trusted Python importer normalizes report datetime strings to date-only UK/ISO fields and computes the same UTC-midnight indexes in its atomic date-family patch, so daily query correctness does not depend on a later trigger. Backend and admin readers continue accepting only strict date-only UK/ISO dates; do not broaden those parsers to silently accept raw report strings.
- `normalizeTourDateIndexes` and `normalizeTourEndDateIndex` reconcile every producer through a transaction on the latest exact tour. Retries derive indexes again and preserve concurrent operational fields; missing/deleted tours are never recreated. Invalid calendar dates and reversed ranges remove stale indexes. They listen only to the two date leaves, avoiding invocations for unrelated high-volume location/participant/safety updates. Deploy Functions before the controlled repair. RTDB rules validate numeric ordering when fields are present; Admin SDK producers still require this explicit reconciliation boundary.
- The date-index backfill is dry-run by default, reads key-ordered pages (50 tours by default, maximum 100), and examines at most 500 tours per invocation (maximum 5,000). `--limit` counts examined records, including unchanged/invalid tours. It reuses the canonical index helper and applies each tour through a fresh transaction, rather than writing a stale root plan. Output distinguishes repaired/cleared/unchanged/missing/invalid records and reports `hasMore`, `nextCursor`, and `complete`. Exit code 2 means invalid dates or remaining work; completion does not mean every date is valid. Resume using `--after-key=<nextCursor>` with identical target arguments. Re-run from the beginning after concurrent source changes, since a key scan is not a global snapshot.
- Both dry-run and apply require explicit `--project=loch-lomond-travel --database-url=https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app`. Apply additionally requires `--confirm-project=loch-lomond-travel --confirm-database=https://loch-lomond-travel-default-rtdb.europe-west1.firebasedatabase.app`. The retained `--allow-full-scan` flag is ignored for older command compatibility; no full-root read occurs. First correct report-derived display dates with the separately reviewed source repair, then reconcile indexes and verify the current-tour query without interpreting its 500-row cap as complete archive coverage.
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
