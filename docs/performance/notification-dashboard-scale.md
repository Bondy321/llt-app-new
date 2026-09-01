# Notification and dashboard scale design

Status: implementation design for `perf/indexed-notification-dashboard`. The
production rollout remains unchanged by this branch.

## Notification audience design

The durable worker keeps one delivery pipeline and selects a bounded candidate
enumerator from `job.audienceType`:

- `single_installation`: one direct canonical device read.
- `tour` and `assigned_drivers`: key-paged `notification_devices` query by the
  server-maintained `operationalTourId`; driver-only jobs share bounded manifest
  and policy context where freshness permits.
- `safety`: the same tour query plus direct device reads for the bounded
  operations-admin directory, deduplicated by installation UID.
- `marketing`: key-paged membership under
  `notification_marketing_audience/v1/{categoryKey}/{authUid}`.

An indexed entry only discovers a candidate. Evaluation must reread the
canonical device and permanent tombstone, then preserve current token,
permission, session-expiry, passenger-membership, driver-profile,
policy-generation, manifest-assignment, sender-exclusion, notification
preference, and marketing-consent checks.

Marketing membership stores only `schemaVersion` and `registrationRevision`.
It contains no token or personal data and is maintained under the existing
device mutation/lock boundary. A missing, stale, or malformed entry safely
skips delivery.

`notification_audience_rollout/v1` accepts `legacy_scan`, `shadow_compare`, and
`indexed`. Missing, malformed, or unknown state resolves to `legacy_scan`.
Shadow mode delivers through the legacy enumerator only and records bounded,
non-identifying mismatch counts.

The marketing backfill pages canonical devices by key with bounded concurrency,
an explicit resume cursor, compare-safe revisions, dry-run default, and guarded
`--apply` plus exact project confirmation.

## Admin dashboard projection design

The server-owned projection is:

```text
admin_dashboard/v1/
  tours/{tourId}
  safety_attention/{eventId}
  recent_broadcasts/{broadcastId}
  summary
  internal/tour_summary_shards/{00..31}
  internal/tour_day_summaries/{yyyy-mm-dd}
  internal/count_contributions/...
  internal/watermarks/...
```

Tour rows contain only scalar list/scorecard fields: identifiers and display
labels, start/end epochs, active state, passenger count and source, capacity and
load percentage, assignment count/summary/flag, source fingerprint, projection
revision, and bounded timestamps. Passenger totals preserve the current order:
explicit participant scalar, participant map count, manifest passenger-status
count, passenger-name count, one-per-booking fallback, then zero.

Safety rows contain only unresolved attention records and safe bounded display
fields. Recent broadcast rows contain only bounded dashboard fields ordered by
server timestamps. No projection contains passenger names, contact details,
booking references, full manifests, tokens, private incident details, or full
message history. Exact detail actions continue to use canonical authorised
records.

Narrow triggers recompute only the affected tour, the old and new tours for an
assignment move, the affected safety event, or the affected broadcast. Builders
reread current canonical state and use deterministic fingerprints plus
compare-safe transactions so retries and out-of-order events cannot restore an
older projection. A per-tour lock and durable completion watermark coalesce
overlapping parent/child trigger deliveries while preserving crash recovery.
All-time tour aggregates are split across 32 deterministic shards. Publication
reads their parent once and retains a fixed `all_time_v1` generation plus the
sum of the ordered 32 shard revisions as its source revision. The window
publisher performs one bounded `orderByKey` query and stores a strictly
validated `start-day..end-day` Europe/London generation separately from the sum
of the ordered day-row revisions. A newer generation commits even if its source
revision is lower; an older generation is stale regardless of revision. Within
one generation, only a higher source revision commits. An exact
generation/revision/fingerprint duplicate is a no-op, while an equal
generation/revision fingerprint conflict is reread and then fails closed. The
scheduled result reports the committed generation, committed source revision,
outcome and current summary fields, so a stale worker cannot report its rejected
candidate as authoritative. Per-tour completion markers also reject lower
projection revisions. Wall-clock timestamps are metadata, never ordering
authority. Calendar-day buckets and a scheduled 15-minute refresh maintain the
operating-window scorecards independently of the 500-row client list cap. The
same refresh pages all projected broadcasts in the trailing 24-hour window and
advances retention cleanup even when no new broadcast arrives.

Projection mode uses hard-bounded queries on `tours/startAtMs`,
`safety_attention/attentionSortKey`, and
`recent_broadcasts/createdAtMs`, plus one direct summary listener.
`admin_dashboard_rollout/v1` accepts `legacy`, `shadow`, and `projection`;
missing, malformed, or unknown state resolves to `legacy`. Shadow renders the
legacy dashboard and performs only bounded background projection comparisons
after every required legacy and projection section has completed one successful
initial listener load. Listener errors keep comparison gated until a subsequent
successful load, preventing transient listener-order mismatches.
It compares tour list fields; safety compound tour/event identity, status,
severity and attention state; broadcast compound tour/broadcast identity,
delivery status, created timestamp and optional recipient count; and the
displayed driver, tour, operating-window, assignment, passenger/capacity,
high-load, safety and broadcast-count metrics. Diagnostics contain only bounded
counts and fixed reason categories—never messages, coordinates, reporter IDs,
complete identifier arrays or other private incident data.

The dashboard backfill pages indexed tours, uses bounded concurrency and a
compare-and-swap resume cursor, writes compare-safely, omits passenger-level
output, defaults to dry-run, and requires guarded `--apply` plus exact project
confirmation. Manual apply cursors require an explicit restart.

## Rules, targets, and tests

Clients cannot read the private notification audience or either rollout record,
and cannot write any index or projection. Only authorised administrators can
read the public dashboard projection children; the internal projection remains
server-only. Required indexes are `notification_devices/operationalTourId`,
`admin_dashboard/v1/tours/startAtMs`, optional tour `endAtMs`,
`safety_attention/attentionSortKey`, and
`recent_broadcasts/createdAtMs`.

Synthetic acceptance targets are deterministic operation and payload counts,
not elapsed time. The checked-in scale gates use 50,000 notification devices
with 53 intended tour recipients, plus 5,000 tours, 50,000 manifest bookings,
1,000 drivers, 12,000 resolved safety records, 120 open safety records, and
10,000 broadcasts. The dashboard harness builds projection rows from those
canonical fixtures and executes the real ordering, window, and limit plan.

### Measured notification work

The baseline is the implementation at starting commit `425f794`. With a page
size of 100, both a single-installation send and a 53-recipient tour send first
walked all 50,000 canonical devices: 500 queries returned 50,499 records
including query lookahead, 50,000 audience-claim transactions ran, and 50,000
user-profile reads/evaluations occurred before scope filtering. A representative
53-passenger tour then required 106 authority reads. If legacy user fallback was
enabled with 50,000 matching profiles, the terminal phase additionally used 500
migration reads, 500 user queries, and 50,000 canonical-device existence reads.

The indexed implementation measures discovery independently of unrelated
devices:

| Workload | Total devices | Intended recipients | Candidate records | Discovery queries | Full-page canonical reads | Authority evaluations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline single installation | 50,000 | 1 | 50,000 | 500 | 50,000 profile reads | 0 |
| Indexed single installation | 50,000 | 1 | 1 | 0 | 1 device read | 0 |
| Baseline operational tour | 50,000 | 53 | 50,000 | 500 | 50,000 profile reads plus 106 authority reads | 53 |
| Indexed operational tour discovery | 50,000 | 53 | 53 | 1 | proportional to 53 candidates | 53 |

The complete one-candidate indexed page test records seven direct reads, one
query, four transaction attempts, one candidate evaluation, one authority
evaluation, one attempt claim, and one prepared provider message. The discovery
test produces identical query and candidate counts with 1,000 and 50,000
unrelated devices.

### Measured dashboard work

The legacy dashboard attached whole-root listeners to `drivers`, `tours`,
`tour_manifests`, `globalSafetyAlerts`, and `broadcasts`; manual refresh read the
same five roots again. In the acceptance fixture that represents 33,000
top-level root children and 78,000 logical records when the 50,000 nested
booking rows are counted. A minimal-field serialization of that fixture is
4,161,319 bytes; this is synthetic evidence, not a production estimate.

The projection query plan performs three bounded queries plus one direct summary
read. It returns at most 500 tour rows, 80 attention rows, 40 recent broadcast
rows, and one summary record: 621 records total and fewer than 250,000 bytes in
the checked-in full-scale harness. Adding canonical history cannot raise those
query limits. A tour row remains below 2,000 bytes when manifest history grows
to 50,000 unrelated booking rows.

| Mutation | Canonical scope read | Projection rows recomputed |
| --- | --- | ---: |
| Tour scalar, passenger, or manifest booking | One affected tour and bounded scalar/summary leaves | 1 tour; duplicate aggregate work is coalesced |
| Driver assignment move | Current driver plus old/new assignment summaries | At most 2 tours |
| Safety event update | One current canonical event | 1 attention row |
| Broadcast update | One current canonical broadcast | 1 recent row; pruning examines at most 20 expired rows |

Stable tour-summary publication now uses one atomic read of the bounded shard
parent instead of 32 independent child reads. Operating-window publication now
uses one bounded day-key range query instead of 22 individual day reads. The
controlled race tests pause stale publishers, allow a complete publisher to
commit, and prove that neither a later wall clock nor the same millisecond lets
the stale candidate or completion marker regress the result.

## Rollout and backfill procedure

Both rollout records remain server-owned and compatibility-first. Deploying the
code alone does not switch either reader. A later approved release should:

1. deploy rules and functions while both records are absent or in their legacy
   phases;
2. run each backfill in dry-run mode and retain only aggregate progress output;
3. run guarded `--apply --confirm-project=<exact-project-id>` invocations until
   each resumable progress record reports complete;
4. enable notification `shadow_compare` and dashboard `shadow`, then evaluate
   only bounded, non-identifying mismatch counters;
5. move one rollout at a time to `indexed` or `projection` after explicit
   approval and observation; and
6. return immediately to the legacy phase if correctness or availability
   signals regress.

This branch does not run either backfill or change either rollout record.

## Known limitations and production profiling

- `operationalTourId` and marketing membership are discovery hints only; stale
  candidates still cost canonical checks and can never grant delivery.
- Safety enumeration also reads the bounded operations-admin directory. Its
  configured cap fails explicitly rather than silently omitting administrators.
- Dashboard summary rows are operational aggregates, not canonical records;
  exact detail and mutation paths continue to use authorised canonical data.
- The web dashboard intentionally shows a bounded operating window. Exact
  searches and detail views retain their existing canonical access paths.
- Broadcast retention is 30 days with pruning capped at 20 rows per query and
  at most 10 pages per scheduled refresh. Cleanup therefore converges after an
  idle period without making one trigger proportional to total history.

After an approved deployment, production validation should compare bounded
query counts, candidate counts, mismatch categories, projection payload bytes,
Function retry/error rates, and dashboard listener health against the synthetic
invariants. Logs and profiler exports must remain aggregated and must not contain
UIDs, push tokens, booking references, passenger data, or raw incident content.
