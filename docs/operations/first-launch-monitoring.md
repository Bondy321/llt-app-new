# First-launch monitoring preparation

`config/first-launch/monitoring-plan.json` contains exact log filters and proposed
initial thresholds, not a claim that alerts have been created. No notification
channel, billing amount or live policy was changed in this task.

The owner selects the verified contact channel and budget amounts. Create the
listed counter metrics without identifier labels, then use one-minute delta
alignment and SUM across revisions, with the listed sustained thresholds.
Create matched-log policies for queue ages with the listed notification periods.
Validate every filter against the corresponding structured test/serving log and
trigger one synthetic alert in an isolated environment before relying on it.

Notification health reports the oldest **due item** in each queue/priority through
nine indexed limit-one reads, not a full backlog count. Deletion health separately
reports bounded phase progress, final completions and failed work. A phase advance
is not a completed account deletion. Retained client crash diagnostics must have
exact release identity; a raw crash count is not a crash-free-session rate.

These targets are proposed operating thresholds, not measured deployed capacity.
Review campaign queue age against expiry before sending. A failed/ambiguous push
submission must not be blindly replayed to make metrics look healthy.

Use Cloud Run max-instances/concurrency and application batch/provider budgets as
actual resource controls. Review project quotas for RTDB/Storage/Auth and image
processing in the intended region. A billing-budget alert only notifies; it does
not impose a hard spending cap. Do not configure automatic essential-service
shutdown as a substitute for capacity/cost review.

The notification log fields are `jsonPayload.queues.{fanout,retry,receipt}` followed
by `{critical,operational,marketing}.{hasDueWork,oldestDueAgeMs}`; health schema is 2.
The timestamp measures lateness after the due time, not time since original
creation, provider delivery latency or total backlog size. A missing health log
must not be interpreted as an empty queue. The prepared filters cover all critical, operational and marketing queue kinds.
The heartbeat counter and `metricAlerts` silence policy aggregate across serving
revisions, alerting after ten minutes of zero/missing schema-2 reports. Attach the
owner-verified channel, observe the first report after policy creation, and prove
silence/recovery in isolation before enabling it. A never-started service does not
prove that an absence policy is active.

The one-hour marketing backlog threshold is deliberately more conservative than
the measured synthetic 60,000-recipient case, whose oldest due receipt reached
three hours. Review that expected alert load with the owner before activation;
local campaign completion does not validate an operational alert threshold.
The capacity report separates real local wall time from virtual scheduler time,
uses mocked Expo responses and an in-process database, and records material
transaction/byte costs. No cloud throughput, current production quotas, live
monitoring policy or provider delivery rate has been verified by those runs.

The heartbeat policy uses the official [Cloud Monitoring metric-threshold condition](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies#MetricThreshold) with missing-data evaluation active; the first-data activation limitation is documented in [Google’s absence guidance](https://docs.cloud.google.com/monitoring/alerts/metric-absence). No policy in this file has been applied.
