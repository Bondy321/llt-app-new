# Firebase Cost Optimization Implementation Playbook (LLT)

## Purpose

This document is now an **implementation-first task plan** for reducing Firebase cost in LLT **without degrading user experience**.

Use it as a working checklist for engineering execution, not a forecasting sheet.

It is grounded in current repository behavior, especially:

- Notification fanout logic in `functions/index.js`.
- Push token + preference persistence in `services/notificationService.js`.
- Chat message/presence/read-state behavior in `services/chatService.js`.
- Photo upload/storage patterns in `services/photoService.js`.
- Realtime Database rules/indexing in `database.rules.json`.

---

## Operating Rules for This Playbook

1. **No UX regressions:** each optimization must preserve current user-visible behavior (or improve it).
2. **Measure before/after:** every completed task must include baseline and post-change metrics.
3. **One-way door caution:** schema/index denormalization must include rollback notes.
4. **Region consistency:** keep backend changes in `europe-west1`.
5. **Do not bundle too much:** ship in small, measurable batches.

---

## Baseline Instrumentation (Do First)

> Do not start optimization tasks until these are tracked for at least 7 days.

### Required metrics

- Realtime Database reads/day by feature path:
  - `chats/*`
  - `internal_chats/*`
  - `users/*`
  - `tour_manifests/*`
  - `group_tour_photos/*`, `private_tour_photos/*`
- Realtime Database writes/day by feature path.
- Cloud Functions:
  - invocation count per function,
  - average/p95 duration,
  - memory tier,
  - cold start ratio.
- Storage:
  - object count growth,
  - GB growth,
  - egress GB/day,
  - average object size uploaded.
- Notification pipeline:
  - notification attempts,
  - valid token ratio,
  - invalid token cleanup rate,
  - push fanout recipients per event.

### Definition of done (baseline phase)

- [ ] 7-day baseline dashboard captured.
- [ ] Cost hotspots ranked by estimated spend contribution.
- [ ] Team agrees top 3 targets for first implementation sprint.

---

## Priority Backlog (Implementation Tasks)

## P0 — Immediate, low risk, high likely return

### P0.1 Add no-op guards for notification triggers

**Problem**

Functions can still perform work for low-value/duplicate updates.

**Actions**

- Add strict early returns for:
  - empty effective chat payload after normalization,
  - itinerary updates where a normalized-hash snapshot is unchanged.
- Record structured skip reasons for auditability.

**Success criteria**

- [ ] Reduced function invocations doing full fanout work.
- [ ] No reduction in legitimate user notifications.

---

### P0.2 Optimize push recipient lookup path (read amplification reduction)

**Problem**

Current fanout path can repeatedly read participant + user nodes per event.

**Actions**

- Introduce a denormalized recipient index:
  - `tour_notification_targets/{tourId}/{userId}` => token + relevant mute flags.
- Maintain index on:
  - participant membership changes,
  - push token changes,
  - preference changes.
- Notification functions read this target map first.

**Success criteria**

- [ ] Significant reduction in `users/*` reads by notification functions.
- [ ] p95 function duration reduction for chat and itinerary fanout.
- [ ] Push behavior unchanged from user perspective.

---

### P0.3 Add token hygiene quarantine and fast-fail

**Problem**

Invalid tokens can be retried repeatedly before cleanup converges.

**Actions**

- Keep existing cleanup but add short-lived quarantine map:
  - token hash,
  - failure count,
  - last failure reason/time.
- Skip known-bad tokens for a cooldown window.

**Success criteria**

- [ ] Lower repeated failed push attempts.
- [ ] Faster convergence to healthy token set.

---

### P0.4 Image upload compression policy enforcement

**Problem**

Photo uploads can be large, increasing storage + egress.

**Actions**

- Enforce client-side compression profile before upload:
  - max long edge,
  - quality target,
  - format fallback strategy.
- Keep full visual quality acceptable for mobile gallery use.

**Success criteria**

- [ ] Average uploaded object size reduced materially.
- [ ] No user-reported quality regression for common use cases.

---

### P0.5 Add missing index audit and rule updates

**Problem**

Any unindexed frequent query in RTDB increases server work and can increase billed usage patterns.

**Actions**

- Audit all `.orderByChild`, `.limitToLast`, and query-heavy subscriptions.
- Add `.indexOn` entries where missing.
- Validate with emulator + production-safe rollout.

**Success criteria**

- [ ] Query-heavy paths index-backed.
- [ ] Reduced slow query logs and latency spikes.

---

## P1 — Medium complexity, substantial efficiency gains

### P1.1 Add short TTL in-memory cache in hot notification functions

**Problem**

Burst traffic repeatedly resolves near-identical user token/pref data.

**Actions**

- Add warm-instance cache for recipient metadata (short TTL).
- Keep cache conservative; stale-safe by combining with denormalized target nodes.

**Success criteria**

- [ ] Lower repeated RTDB reads during bursts.
- [ ] No preference correctness incidents.

---

### P1.2 Active-thread notification suppression

**Problem**

Users currently active in the chat thread may still be eligible for push fanout.

**Actions**

- Track lightweight thread presence/foreground signal.
- Suppress push for active-in-thread recipients only.

**Success criteria**

- [ ] Fewer pushes sent without reducing effective message awareness.
- [ ] No increase in missed-message complaints.

---

### P1.3 Thumbnail-first media delivery

**Problem**

Gallery/list views may fetch larger media than needed.

**Actions**

- Create thumbnail variant per upload.
- Use thumbnail for lists; full image only on explicit open.

**Success criteria**

- [ ] Egress per photo view reduced.
- [ ] Faster perceived gallery loading.

---

### P1.4 Write coalescing for settings/presence/read-state updates

**Problem**

Some frequently updated nodes can create avoidable write churn.

**Actions**

- Debounce/coalesce settings updates where values are unchanged.
- Use no-op write suppression for read receipts / presence updates if payload equivalent.

**Success criteria**

- [ ] Reduction in redundant writes/day.
- [ ] No UX regressions in read-state or presence indicators.

---

## P2 — Advanced hardening and long-term controls

### P2.1 Trigger idempotency ledger for retry safety

**Problem**

At-least-once execution can duplicate expensive downstream work.

**Actions**

- Add event-id idempotency keys with TTL storage.
- Ensure duplicate event handling exits before expensive fanout.

**Success criteria**

- [ ] Duplicate processing rate near zero.

---

### P2.2 Function instance and memory tier right-sizing

**Problem**

Default/max settings may not match actual traffic profile.

**Actions**

- Tune per-function concurrency, min/max instances, and memory tiers.
- Use p95 latency SLO + cost targets as optimization boundary.

**Success criteria**

- [ ] Lower compute cost with SLO maintained.

---

### P2.3 Storage lifecycle management policy

**Problem**

Old originals can accumulate with low retrieval value.

**Actions**

- Define retention policy by content type and age.
- Transition/delete stale assets in a policy-safe manner.

**Success criteria**

- [ ] Storage growth rate reduced over time.
- [ ] No unexpected content loss.

---

## Additional Opportunities Found in Second Repo Pass

These items were added after re-checking current services/functions for cost-sensitive patterns.

### A. Chat presence and typing signal optimization

`chatService` writes typing/presence/read-state frequently and subscribes broadly.

**Actions**

- Move typing cleanup to strict TTL semantics and avoid redundant updates.
- Avoid presence writes when status has not changed.
- Evaluate reducing payload fields in presence nodes.

**Expected benefit**

- Fewer high-frequency writes and listener churn.

---

### B. Read receipt write frequency controls

`markChatAsRead` and `markInternalChatAsRead` can generate frequent writes.

**Actions**

- Add minimum interval threshold before writing a new read timestamp.
- Ignore writes when last timestamp is within small tolerance window.

**Expected benefit**

- Reduced write volume on heavy-chat days with no user-visible loss.

---

### C. Photo metadata payload trimming

Photo metadata currently stores rich fields useful for diagnostics; some may be optional at scale.

**Actions**

- Review metadata fields required by UI and moderation flows.
- Remove/relocate non-essential fields to reduce RTDB payload size where safe.

**Expected benefit**

- Lower bandwidth and marginal read/write cost improvements.

---

### D. Preference write path deduplication

`saveUserPreferences` can update multiple fields repeatedly.

**Actions**

- Compare current vs incoming preference object before write.
- Skip full write if no meaningful change.
- Separate infrequently changing device metadata from preference writes.

**Expected benefit**

- Lower write volume and less downstream trigger noise.

---

## Execution Plan (Task-by-Task)

## Sprint 1 (Start here)

- [ ] Baseline metrics complete (7 days).
- [ ] P0.1 no-op trigger guards.
- [ ] P0.4 image compression policy.
- [ ] P0.5 index audit + rules update.
- [ ] P0.3 token quarantine.

**Exit criteria:** measurable reduction in avoidable function/runtime/storage overhead, no UX regressions.

## Sprint 2

- [ ] P0.2 notification target denormalization.
- [ ] P1.1 short TTL function cache.
- [ ] P1.2 active-thread suppression.
- [ ] P1.4 write coalescing (settings/read-state/presence).

**Exit criteria:** major read amplification reduction and push efficiency improvements.

## Sprint 3

- [ ] P1.3 thumbnails rollout.
- [ ] P2.1 trigger idempotency.
- [ ] P2.2 function right-sizing.
- [ ] P2.3 storage lifecycle policy.

**Exit criteria:** stable long-term cost controls with predictable trend lines.

---

## Validation Checklist for Every Optimization PR

- [ ] Baseline metric reference attached.
- [ ] Post-change metric reference attached.
- [ ] Confirmed no UX regression (manual QA + targeted tests as appropriate).
- [ ] Rollback plan documented.
- [ ] Alerting updated if new failure mode introduced.

---

## Guardrails / What Not To Do

- Do not change core database path names guarded by rules (`drivers`, `tours`, `users`, `bookings`, `tour_manifests`).
- Do not migrate large architecture surfaces and cost optimizations in one release.
- Do not rely on locale-dependent date parsing in new optimization code.
- Do not remove user-value notifications to save cost; optimize delivery efficiency instead.

---

## Definition of Success (Program Level)

This initiative is successful when:

1. Cost growth is materially below MAU growth rate.
2. Notification reliability is maintained or improved.
3. Chat/media UX remains equal or better.
4. Engineering can explain top cost drivers with dashboard evidence.
5. Ongoing optimization becomes a repeatable operating practice.
