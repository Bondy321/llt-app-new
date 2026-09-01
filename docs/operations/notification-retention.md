# Notification retention operations

This runbook covers the durable notification compactor only. It does not authorise changes to
notification delivery, audience selection, App Check, Expo security, mobile releases, customer data,
or unrelated Firebase roots.

## Safe status inspection

Use the retention preflight and rollout-manager status commands in their default read-only modes.
Keep only aggregate JSON: phase and revision, preparation completion, due/deferred/attention counts,
page/query/update-path maxima, oldest due age, shadow mismatches, orphan counts and evidence digest.
Never copy job, attempt, source, user, tour, booking, token or receipt identifiers into an incident.

The canonical `notification_jobs/{jobId}` record is delivery authority. Its matching private
retention job is the authoritative due-state item; the compatibility queue projection never grants
permission to delete or deliver. Before interpreting a stalled item, verify:

1. rollout phase and revision;
2. canonical terminal status and immutable first `completedAtMs`;
3. explicit `retentionDueAtMs`, or privacy-tombstone expiry;
4. fanout and retention lease owner/revision/expiry;
5. manual-requeue state and retry/receipt queues;
6. durable retention phase, cumulative counters, scheduler/orphan/requeue-recovery cursors and generation;
7. bounded operations warning reason.

## Failure response

| Signal | Required response |
| --- | --- |
| Missing or malformed rollout | Enter only the raw-fingerprint-bound legacy revision-zero compatibility path; never run shadow or compactor work. |
| Malformed canonical job or completion boundary | Fail closed; do not create or advance destructive work. |
| Live fanout lease, requeue or incompatible transition | Defer the job without consuming its fairness slot; reread later. |
| Retention lease contention | Preserve queue and cursor; the exact owner/revision may continue until expiry. |
| Crash during attempt or child cleanup | Resume from the durable phase and counters. Repeating the exact page is idempotent. |
| Rollout/evidence changes after a destructive unit starts | Let only that bounded unit settle, retain its `destructiveCommit` fence, report `rollout_changed`, and permit only a retention worker to recover it. Manual requeue remains blocked. |
| Source/coalescing pointer changed | Preserve the newer pointer and remove only the retained job's exact ownership reference. |
| Orphan parent reappears during repair | Preserve the child; the canonical reread wins. |
| A crashed requeue cannot resume from the current bounded prefix | Advance the rollout-bound recovery cursor; preserve the failed record and reach later due work on the next invocation. |
| Update-path, page, query or memory budget reached | Commit only the completed bounded page, release/renew safely, and return `hasMore`. |
| Shadow mismatch, canary residual or retention warning | Stop activation and return/retain `legacy`. Preserve canonical and private state. |

Do not manually broad-delete a notification root, edit a cursor around a malformed record, clear a
live lease, or infer eligibility from `updatedAtMs`. Operations warnings use deterministic hashed
identifiers; investigate through authorised backend logs without exposing the raw identifiers.

## Immediate rollback

Compare-and-set `notification_retention_rollout/v1` to `legacy` with the exact observed revision,
`--apply`, and exact project confirmation. A backward transition is never blocked by forward evidence
gates. The revision increment invalidates every older compactor worker before another destructive
page, phase or auxiliary sweep. An already-started bounded page can settle; its stale worker cannot
advance durable state or report its deletion metrics, and no later destructive unit may begin.
If a process was killed after installing a canonical fence, legacy/shadow recovery compare-cancels
only the exact lease-versioned fence whose matching state lease and revision are expired. The
missing-rollout legacy fallback is limited to revision zero and is bound to the exact raw rollout
fingerprint. Foreign, malformed, superseded and live fences remain fail-closed.

Before a root update or source deletion, the worker marks a durable destructive commit and extends
its lease to 660 seconds, which is longer than the 540-second Function timeout. Even after that lease
expires, manual requeue cannot cancel a destructive commit marker. Only a retention worker may
recover it, finish or replay the bounded idempotent unit, and clear the marker on a durable phase
transition. A pre-commit crash has no marker and retains the ordinary 120-second takeover path.

Keep the Functions and private rules deployed while diagnosing the incident. Preserve retention jobs,
queue entries, repair/preparation cursors, evidence and warnings. Do not restore production by deleting
private state or recreating canonical notification data. After a fix, rerun the complete local and
exact-head CI gates, production preflight, preparation validation, shadow comparison and bounded
canary from a fresh rollout revision.

## Guarded command sequence

Use placeholders in retained evidence and rerun status before every mutation. Every command validates
the active Firebase project; preparation and all destructive commands additionally require the exact
expected rollout phase, and mutations compare the exact revision.

```text
npm --prefix functions run retention:rollout -- status --confirm-project=<firebase-project-id>
npm --prefix functions run retention:preflight -- --confirm-project=<firebase-project-id> --expected-phase=legacy
npm --prefix functions run retention:prepare -- --confirm-project=<firebase-project-id> --expected-phase=legacy
npm --prefix functions run retention:prepare -- --apply --confirm-project=<firebase-project-id> --expected-phase=legacy --expected-revision=<revision>
npm --prefix functions run retention:rollout -- set --apply --confirm-project=<firebase-project-id> --expected-phase=legacy --expected-revision=<revision> --phase=shadow --preparation-complete --evidence-digest=<digest>
npm --prefix functions run retention:shadow -- --apply --confirm-project=<firebase-project-id> --expected-phase=shadow --expected-revision=<revision>
npm --prefix functions run retention:rollout -- set --apply --confirm-project=<firebase-project-id> --expected-phase=shadow --expected-revision=<revision> --phase=compactor --preparation-complete --evidence-digest=<digest>
npm --prefix functions run retention:canary -- --apply --confirm-project=<firebase-project-id> --expected-phase=compactor --expected-revision=<revision> --evidence-digest=<digest>
npm --prefix functions run retention:rollout -- set --apply --confirm-project=<firebase-project-id> --expected-phase=compactor --expected-revision=<revision> --phase=compactor --activate-after-canary --evidence-digest=<digest>
npm --prefix functions run retention:run -- --apply --confirm-project=<firebase-project-id> --expected-phase=compactor --expected-revision=<revision>
```

Preparation and shadow are resumable, not single-shot commands. Repeat the preparation apply command
with the same exact legacy revision until its bounded result reports `preparationComplete=true`,
rereading rollout status between invocations. Rerun once more to prove idempotence. After entering
shadow, repeat the exact-revision shadow command until the durable shadow evidence reports
`status=passed` and `hasMore=false`; stop on any mismatch, attention count, revision change, or failed
evidence write. Never advance because one bounded invocation merely returned successfully.

The shadow-to-compactor transition enters a fail-closed paused compactor state (`canaryPassed=false`).
The deployed scheduler returns `canary_paused` and performs no retention mutation in that state. Only
the explicitly bounded canary may use the production compactor path. It creates or resumes one
deterministic, content-free server-owned fixture bound to the paused revision and targets only that
fixture; ordinary due jobs and auxiliary records are untouched. A passing, fingerprint-bound
canary is then activated by the same-phase compare-and-set command above; normal synchronous and
scheduled cycles reject the paused state. Rerunning the same canary is evidence-idempotent.

The ready rollback command is:

```text
npm --prefix functions run retention:rollout -- set --apply --confirm-project=<firebase-project-id> --expected-phase=compactor --expected-revision=<revision> --phase=legacy
```

From shadow, use the same compare-safe form with the exact shadow phase and revision:

```text
npm --prefix functions run retention:rollout -- set --apply --confirm-project=<firebase-project-id> --expected-phase=shadow --expected-revision=<revision> --phase=legacy
```

## Rules-first deployment scope

After merge and exact-main CI, deploy only the reviewed Realtime Database rules and affected
Functions, in that order, using the repository-pinned CLI:

```text
node_modules\.bin\firebase.cmd deploy --only database --project <firebase-project-id>
node_modules\.bin\firebase.cmd deploy --only functions:cleanupNotificationDeliveryData,functions:processNotificationDeliveryJob,functions:processNotificationReceipts,functions:recoverNotificationDeliveryJobs,functions:requeueNotificationJob,functions:createServerTestNotification,functions:previewNotificationAudience,functions:processBroadcastWrite,functions:processCategoryBroadcastWrite,functions:sendChatNotification,functions:sendInternalChatNotification,functions:sendDriverTourPackChangeNotification,functions:sendItineraryNotification,functions:sendSafetyAlertNotification,functions:processAccountDeletionJobs,functions:retryAccountDeletion --project <firebase-project-id>
```

If the CLI reports a quota-project 403, set `GOOGLE_CLOUD_QUOTA_PROJECT=loch-lomond-travel` for that
shell and rerun the same exact command. Do not deploy Hosting, unrelated Functions, App Check, or an
OTA/mobile build. Reread deployed rules, export schedule, timeout and private rollout state before
any production preparation or phase mutation.

After preparation, a nonzero count of safely classified historical orphans is repair work, not an
activation blocker. Any malformed or ambiguous orphan increments `requiresAttention` and blocks a
forward transition. Shadow writes only bounded aggregate evidence under
`notification_retention/v1/evidence/shadow`; the `shadow -> compactor` transaction requires passing
evidence from the exact shadow revision and matching preparation digest.

## Synchronous recovery evidence

A recovery is eligible for activation only when the separately retained exact deployed-head checks
and the server-owned rollout/preparation evidence agree. `evidenceDigest` is the preparation evidence
digest (schema, rollout revision, cumulative counts and completion), not a source-SHA or deployment
configuration digest:

- all six GitHub CI jobs passed;
- deployed rules and Function exports match the reviewed repository;
- preparation is complete with no malformed eligible candidates;
- shadow safety mismatches and budget breaches are zero;
- the bounded canary has no residual child, queue or orphan state;
- no open notification-retention terminal warning exists;
- status reread reports the expected phase/revision.

These checks are server-side and synchronous. They do not require a physical device, production
billing comparison, waiting several days, or human-only observation.
