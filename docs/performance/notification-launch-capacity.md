# Notification launch capacity evidence

## Workload and acceptance targets

Declared before the final measured runs on 24 October 2026. These are test inputs,
not a customer forecast. The addressable population is 60,000 installations across
800 tours of 75 installations; actual consented recipients vary by workload. This
notification harness makes no assumptions about simultaneous logins, physical
phones, media downloads or customer behaviour. Those have separate acceptance.

| Workload | Canonical population | Eligible messages | Injected provider behaviour | Local target | Virtual queue target |
| --- | ---: | ---: | --- | --- | --- |
| Normal |60000|100|Accepted tickets and receipts|Fanout page p95 below 5 s; peak heap below 1 GiB|Complete within 30 minutes including a 15-minute receipt wait|
| Launch campaign |60000|60000|Accepted tickets and receipts|Fanout page p95 below 5 s; peak heap below 1 GiB|Complete within 4 hours; no pending counters|
| Reconnect storm |60000|6000|First send gets definite 429; retry accepts|Retry sweep p95 below 10 s; peak heap below 1 GiB|Complete within 2 hours; no pending counters|

Every workload must have zero duplicate accepted internal provider submissions, zero live
network calls, exact job/source counter convergence, empty retry/receipt queues
and retention eligibility. One 75-recipient tour among 60,000 must use one indexed
query; discovery uses 100 candidates plus one pagination lookahead. Separate actual
worker tests put two unfinished campaigns beside chat, itinerary and critical
safety pages, requiring every lane to make progress in one bounded sweep.

Commands (patched trusted Node 24; scripts run sequentially):

```text
node scripts/notificationLaunchScale.js --scenario=normal --output=normal.json
node scripts/notificationLaunchScale.js --scenario=launch --output=launch.json
node scripts/notificationLaunchScale.js --scenario=reconnect --output=reconnect.json
```

The harness uses production audience, attempt, queue, accounting, receipt, retry,
job/source publication and retention-eligibility logic. Firebase is an in-process
transactional adapter; Expo is mocked. HTTP/HTTPS/socket/fetch creation fails the
run. Cold/offline Firebase SDK commit semantics are tested separately against
loopback RTDB with the repository rules installed only in that emulator. The scale
harness creates no real Auth accounts or deliveries.

## Provider and queue bounds

Expo documents 600 messages/second/project, 100 messages/send request and 1,000 receipt
IDs/request. Receipts should first be checked after 15 minutes and expire after 24 hours.
There is no delivery SLA. Sources: [Expo sending notifications](https://docs.expo.dev/push-notifications/sending-notifications/)
and [Expo documentation source](https://github.com/expo/expo/blob/main/docs/pages/push-notifications/sending-notifications.mdx),
checked 24 October 2026.

All workers share one project budget: 500 messages across two adjacent seconds,
marketing maximum 300, leaving 200 operational slots. A reservation cannot be used
after its second expires. These are dispatch-admission bounds, not a guarantee
about when Expo/APNs/FCM processes an already-dispatched network request.

Fanout recovery reads 10 entries/lane/minute; event-triggered continuation also
runs. Receipt sweeps read 333/lane/minute (999 total); retry sweeps 100/lane/minute
(300 total). Lanes are critical, operational, marketing. Each has its own indexed
query and cannot be crowded out by older rows in another lane. Unused capacity is
not borrowed. A single 60,000-receipt marketing backlog therefore needs 181 successful
minute sweeps; a 6,000-retry backlog needs 60. This arithmetic is a scheduler service
budget, not observed cloud throughput. A 60,000 all-retry campaign would require at
least 10 hours plus receipts and must be separately accepted before using that case.

The fanout trigger has at most 20 instances, concurrency 1 each. Recovery has one instance, concurrency 1 and five admitted pages, so these paths admit at most 25 fanout pages concurrently; each prepares at most ten candidates concurrently. The shared provider budget applies across all of them.

The receipt/retry scheduler has one instance and concurrency 1, with a 300-second
hard timeout. A batch slower than its 60-second cadence reduces achieved throughput;
raising timeout alone does not certify throughput. Expired/ambiguous requests are
not silently resent. Every request and transaction is bounded by page/attempt/job;
no production transaction covers the whole database.

Accounting retains at most 1,024 attempt receipts per hash shard and 256 shards/job.
A full shard fails closed and needs an alert. Job summaries are fixed 7-counter
vectors keyed by shard. Retention replaces ledgers with 256 permanent retired shard
markers per job, approximately 5 KiB before database overhead; this is an intentional
anti-resurrection storage cost that must be included in long-term cost review.

## Measured results

The frozen original production transition from commit `05ba9d1d285f45e4d33b7bd9ad20749bd3e4c945` reproduced the reported defect in an isolated atomic-update adapter: two completed attempts left `ticketAccepted=2`, `receiptAccepted=2`, `retrying=1` after delayed old preparation publication. The extracted function SHA-256 was `102350f1bf56d989bc93e3b25cb2502fd652e4e9bd0331589d7dda12d2736887`. This reproduction made no provider calls and establishes phantom accounting, not duplicate push display. Current regression tests exercise admitted-sibling draining, stale exact-version rejection and replay after every publication boundary; separate cold/offline SDK tests exercise actual queued transactions and successor/deletion fencing.

Measured with Node 24.22.1 on the shared Windows laptop, with tests run sequentially. These are actual complete workload runs, not extrapolations. `test:notifications:scale` is a manual capacity check; the 60,000 case is intentionally outside normal CI.

| Metric | Normal: 100 eligible / 60,000 population | Launch: 60,000 eligible |
| --- | ---: | ---: |
| Fanout pages / receipt sweeps | 1 / 1 | 600 / 181 |
| Local wall duration | 0.442 s | 1,740.950 s (29.016 min) |
| Fanout page p50 / p95 / p99 | 218 / 218 / 218 ms | 1,923 / 3,114 / 4,091 ms |
| Receipt sweep p50 / p95 / p99 | 54 / 54 / 54 ms | 2,189 / 5,045 / 6,443 ms |
| Direct reads / transactions / writes | 516 / 2,419 / 2,718 | 304,271 / 1,445,351 / 1,624,571 |
| Serialized read / write payload | 3.215 / 3.206 MB | 7.723 / 7.725 GB |
| Largest read / write payload | 28,501 / 5,321 bytes | 94,906 / 29,436 bytes |
| Sampled peak heap / peak resident | 69.0 / 184.5 MiB | 885.2 / 1,087.3 MiB |
| Virtual completion, including receipt wait | 16 min 2 s | 3 h 36 min |
| Oldest observed due receipt age | 2 s | 3 h 2 s |
| Final provider accepted / retrying / receipt pending | 100 / 0 / 0 | 60,000 / 0 / 0 |

Both runs passed every predeclared target, including zero duplicate submissions, exact source/job accounting, empty retry/receipt queues and retention eligibility. The 75-recipient tour required one bounded indexed query among 60,000 installations. The launch run's slowest individual fanout page was 7.921 s; the declared target was p95 below 5 s, not every page below 5 s. Serialized bytes include adapter transaction snapshots; they are not billed network traffic. Writes include transaction writes and must not be added to the transaction count as if independent operations.

The observed 1.45 million transactions and approximately 7.7 GB each of serialized reads and writes make cloud contention and cost acceptance material, even though local bounds passed. This evidence does not establish deployed capacity for a 60,000-recipient campaign. Verify the isolated cloud goals below before claiming that capacity.

The reconnect workload also passed every target: 6,000 eligible devices among
60,000, with each initial 100-device batch receiving one definite mocked HTTP 429.
It completed 60 fanout pages, 60 retry sweeps and 19 receipt sweeps in 86.890 s local
wall time and 96 min virtual time. Fanout p95 was 544 ms, retry p95 1,781 ms (p99 2,865 ms)
and receipt p95 1,164 ms. Sampled peak heap was 233.1 MiB and peak resident 364.2 MiB.
There were 6,060 mock provider requests, 60 injected errors and 6,000 accepted
messages/receipts, with zero duplicate accepted submissions. All retry/receipt
queues drained and source/job counts converged with retention eligibility.
The run measured 78,617 reads, 258,545 transactions and 282,467 writes, with 1.043 GB
serialized reads and 0.957 GB writes; the largest read/write was 94,906/13,199 bytes,
the maximum query 333 records and oldest observed due age 59 min. These results
include normal backoff and the deliberately reserved per-lane sweep capacity.

Machine-readable evidence is written by the command's `--output` argument. The
full run files are `verification/launch-notification-scale-normal-final.json`,
`verification/launch-notification-scale-60000-final.json` and
`verification/launch-notification-scale-reconnect-final.json` in the parent
workspace. The large launch run preceded later authority-rule edits; those edits
do not participate in this marketing adapter workload, and current rules require
separate SDK acceptance. The reconnect run used the final job CAS/outbox recovery
implementation as well as the attempt publication fix.

## What remains unverified in the cloud

Reuse the workload specification in an isolated, representative deployment
with provider stubs and synthetic identities only before asserting cloud capacity. The current harness is an in-process adapter; a cloud adapter and cloud run have not been implemented or performed.
Measure real billed bytes, RTDB transaction conflicts/retries, function CPU/memory,
cold starts, event lag, provider admission timing and cost. Required service goals:
critical/operational first-dispatch p95 below 60 seconds under campaign contention;
receipt/retry batch p95 below 60 seconds at configured budgets; oldest operational
retry age below 2 minutes except explicit backoff; 60,000 normal-campaign accounting
converged within 4 hours and before receipt expiry. Any missed goal requires capacity
or queue-budget correction and rerun. Heap is sampled after each bounded operation; resident memory includes the OS
process high-water mark where supported. Local p95 is JavaScript+adapter CPU time,
not a network, phone or deployed-service latency estimate.

Before activation stop old notification producers/consumers and drain in-flight
old provider calls; then activate the coherent v2 workers/rules/admin together.
Old private delivery roots remain preserved for explicit owner review. Do not
blindly delete historical delivery, source messages, consent or business records.
No live reset or notification deployment has been performed by these tests.
