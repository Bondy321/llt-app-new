# Notification retention scale design

The notification compactor replaces the fixed `100`-record daily cleanup limit with durable,
job-centric, volume-proportional work. It does not change notification delivery, audience selection,
the 30-day minimum retention period, account-deletion tombstones, or business-record ownership.

## Authority and storage

`notification_jobs/{jobId}` remains the only delivery authority. Retention metadata is private under
`notification_retention/v1`; clients, including operations administrators, cannot read or write it.
The rollout record is separately private at `notification_retention_rollout/v1`.

Each `notification_retention/v1/jobs/{jobId}` record is both durable phase state and the
authoritative indexed due-queue item. Scheduling transacts only that child. The separate `queue`
tree is a non-authoritative rollback projection for the prior worker and never grants deletion
authority.

An ordinary job is discoverable only from its once-written `retentionDueAtMs`. At execution time the
worker rereads the canonical job and requires a recognised terminal status, the same immutable first
`completedAtMs`, elapsed retention, no live fanout lease, no active manual requeue, no incompatible
retry/receipt transition and no retention hold. Missing or malformed boundaries fail closed.
`privacy_deleted` records use only their explicit tombstone expiry.

## Deterministic budgets

The checked-in scale harness uses these upper bounds rather than elapsed wall-clock time:

| Budget | Bound |
| --- | ---: |
| Attempt page size | 250 records |
| Attempt query limit | 251 records (one lookahead record) |
| Attempts per job per invocation | 1,000 records |
| Attempt pages per job per invocation | 4 pages |
| Attempts across all jobs per invocation | 5,000 records |
| Retention jobs per invocation | 25 jobs |
| Root update paths per atomic commit | 500 paths |
| Internal safety deadline | 420 seconds |
| Lease duration | 120 seconds |
| Destructive commit lease | 660 seconds (longer than the 540-second Function timeout) |
| Lease renewal threshold | 45 seconds remaining |
| Orphan attempt page | 250 records plus one lookahead |
| Orphan pages per invocation | 4 pages |
| Terminal scheduling-repair pages per invocation | 4 pages |
| Expired preview page | 250 records plus one lookahead |
| Expired requeue page | 250 records plus one lookahead |
| Crashed requeue recovery page | 250 records plus one lookahead |
| Expired marketing-details page | 250 records plus one lookahead |
| Preview/requeue/marketing auxiliary pages per invocation | 4 pages per root |
| Scheduled cadence | Every 15 minutes |
| Function timeout | 540 seconds |
| Shadow records per invocation | 500 across durable scan stages |

One 50,000-attempt campaign therefore needs exactly 200 attempt pages and 50 scheduled invocations
at the four-page, 1,000-attempt per-job fairness ceiling. Across distinct jobs, one invocation may
process at most 5,000 attempts. The legacy limit would remove at most 100 attempts per day and need
500 daily runs for the same campaign. No scheduled result may claim completion when a lookahead
record proves that more work remains; an exactly full final page must still complete without a false
`hasMore` result.

The worker holds only the current page, its bounded deletion plan, and aggregate counters in memory;
every page query is bounded to at most 251 records including its lookahead record.
Adding 100,000 unrelated attempts or jobs must not change query count, selected records, maximum page
size, update-path count, or memory-record count for the selected job.

A durable scheduler cursor rotates due-job discovery after every active invocation and wraps at the
current due boundary. A campaign that fills the first 25 discovery slots therefore cannot starve a
later small job. Canary mode disables that rotation and targets one deterministic, content-free,
server-owned fixture bound to the exact paused rollout revision. Ambient production jobs and
auxiliary sweeps are excluded from the canary invocation.
The shadow-to-compactor transition is paused until a fingerprint-bound bounded canary passes; scheduled
workers make zero compactor mutations during that pause.

Shadow comparison stores only a fixed evaluation timestamp, compound cursors, counts and
order-independent aggregate digests. It scans the authoritative due-state and legacy candidate
streams across resumable invocations, so a backlog above 500 records converges without retaining job
identity sets. Authoritative legacy mutation begins only after both pre-mutation scans complete.

Legacy compatibility cleanup uses separate durable compound cursors for canonical jobs, terminal
attempts, marketing details and crashed requeues. Each cursor is bound to the exact rollout phase,
revision and raw rollout fingerprint. The active compactor's requeue-recovery cursor is separately
bound to the exact compactor revision and evidence digest. Preserved or unrecoverable records at the
front of a bounded query therefore cannot permanently starve later eligible records.

## Crash and concurrency boundaries

The retention job owns a revisioned lease and durable phase/cursor. Attempt pages, recipient/claim
children, runnable queues, warnings/details, source/coalescing reconciliation and parent deletion are
separate replayable phases. Cursor and phase advance only under the exact lease owner/revision. Two
workers cannot advance the same page, and a stale worker cannot commit after lease takeover.

Immediately before a destructive unit, state and canonical fence carry a `destructiveCommit` marker
and a 660-second lease. Manual requeue cannot recover that marker even after expiry; only a retention
worker can replay/finish the bounded idempotent unit and clear the marker with the durable phase
transition. This prevents an accepted requeue from overlapping a delayed root update while retaining
ordinary 120-second recovery for crashes that happen before destructive work begins.

The compactor also carries the exact rollout revision into every job fence check. A compare-safe
rollback to a newer `legacy` revision stops the worker before its next page or phase and prevents
stale state or metrics from committing after an already-started bounded update. Auxiliary repair and
expiry work rechecks the same authority at every bounded page or sweep boundary.

Manual requeue, retry and receipt processing reread the canonical job. An accepted requeue increments
the delivery generation and invalidates pending retention work before it can delete any page. A
retention worker checks that generation immediately before each destructive commit. Both compactor
and legacy fences have an owner, revision and expiry; an expired owner cannot renew after an exact
manual-requeue takeover. Crashed processing requeues retain a due-recovery marker and are resumed by
the scheduled worker through bounded fair pages. Missing parents, child-only attempts and queue
pointers are repaired in bounded key order with a durable timestamp watermark; a concurrently
recreated canonical parent causes repair to preserve the child.

## Scale evidence

Deterministic tests cover a 50,000-attempt job, small-job fairness beside that job, blocked-job
progress, exact `hasMore` behavior on full and partial final pages, a 500-path ceiling, bounded memory,
orphan throughput, and invariance after adding 100,000 unrelated records. Tests assert query/page/read
and update-path counters, durable scheduler rotation, mid-cycle rollback fencing and not machine speed.

Production logs and rollout evidence contain aggregate counters and bounded reason codes only. Job,
attempt, source, run, user, tour, booking, token and receipt identifiers are omitted or passed through
the safe logger's masking boundary.
