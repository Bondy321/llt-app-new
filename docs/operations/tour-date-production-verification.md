# Tour date production verification — 9 October 2026

The admin's current/upcoming view was empty because all eligible imported tours
lacked `endDateEpochMs`. UK report values with midnight suffixes had also been
stored without canonical dates. The source fix was on main but its deployment
and historical repair had not been applied.

## Source and deployments

- Admin change: PR #468, main `7bfd060b65e477a3c6fbe5ebc129a33c350a26f8`.
  All six required CI gates passed. The production Hosting HTML matches the local
  production build.
- Importer: `llt-app-sync` main `e6ba892cfe6967b0289a851bbe04db45410e21db`.
  Cloud Build `15acb34e-fa54-47d4-959c-54b7525bfda1` succeeded.
- Job `llt-app-sync-daily`, `europe-west1`, generation 25, uses the pinned image
  `europe-west2-docker.pkg.dev/loch-lomond-travel/llt-sync/llt-app-sync@sha256:d902bf04f696e213263178ab7f74e803fea1ec6d24b022c333dbe9f3c5d4896d`.
  Only its image was changed; service account, secrets, live-write arguments and
  resource configuration were preserved.
- Functions `normalizeTourDateIndexes` and `normalizeTourEndDateIndex` were
  redeployed successfully in `europe-west1`, Node 22, before the repair.
- Scheduler `llt-app-sync-daily-0710` remains enabled at `10 7 * * *`,
  `Europe/London`, selecting the 7am filename batch.

## Repair and subsequent import

A fresh metadata-only capture contained 2,145 tours. The reviewed plan repaired
2,139 records and 8,835 fields through six bounded ETag transaction batches;
there were no conflicts or errors. The six historical end-date disagreements
were excluded and their captured metadata remained unchanged. Journals and
metadata-only verification files remain locally in the ignored importer folder
`output_date_repair/2026-10-09`.

Production verification exposed a second fault: one complete importer patch
exceeded Firebase's 500 Gen 2 Function invocations per region per write. The
writer now keeps whole tour/date/itinerary/pickup groups and booking/identity
pairs together, with limits of 10 groups, 200 paths and 512 KiB per request. It
rechecks ownership against fresh records before each batch, stops after any
failure, reports acknowledged progress without raw identifiers, and treats a
no-op as success. Its remaining read/plan/write concurrency boundary is described
in the importer runbook.

Execution `llt-app-sync-daily-7vtpx` then completed successfully in 1m55.83s with
553 acknowledged requests and 36,808 applied paths. It used the normal production
job arguments and the 9 October 7am reports. The subsequent metadata audit found:

- 2,139 unchanged valid date families; zero further eligible repairs.
- All 507 tours in the source reports matched all seven persisted date fields.
- 517 current/upcoming indexed departures.
- The same six excluded historical conflicts, requiring authoritative source
  evidence before their dates can be changed.

A second normal execution, `llt-app-sync-daily-p2fg6`, also succeeded. It planned
zero paths and made zero write requests, confirming that repeating the same
morning reports is a successful no-op in the deployed pipeline.

## Pickup and passenger consistency

Visual verification exposed another consequence of changing the date parser:
the existing merge compared raw pickup dates, so timestamped and date-only
representations of the same pickup/passenger were appended as separate rows.
The final importer normalizes recognized civil dates before matching and repairs
those duplicate representations while preserving existing nonblank coordinates,
contact fields and other operator details. Different dates, times, locations,
names and seats remain distinct; repeated same-name/unassigned passengers retain
their multiplicity across reports rather than becoming a set.

The preview identified 13,523 format-duplicate passenger rows and 1,453
format-duplicate pickup rows. The merge retains every booking's source passenger
count and also preserves 673 existing passenger rows and 46 pickup rows with
different identity dimensions from the current reports. Those differences are
recorded for pilot data review, not automatically treated as cancellations.

Final execution `llt-app-sync-daily-t9vk8` succeeded in 2m7.78s with 558 requests
and 31,707 paths. Replay `llt-app-sync-daily-lrjd5` succeeded with zero writes.
A fresh UTF-8 audit found 14,196 retained passenger rows and 1,499 pickup rows,
no pending list changes, and no booking below its source row count. A separate
container smoke test confirmed both runtime module hashes match the reviewed
local code and that same-name/unassigned party multiplicity is preserved. The
final date audit still has zero eligible repairs and the six unchanged historical
conflicts. Early local list-audit counts were corrected after an audit-only
Windows text-encoding error; production CSV readers and JSON writers use UTF-8.

## Validation and visible behaviour

The importer passed 72 ordinary tests and four actual RTDB emulator tests. These
cover CAS repair retries, deletion, operational-field preservation, bounded SDK
writes, indexed query inclusion, idempotence, payload growth, failure midway
through a report, refreshed itinerary ownership checks, list-date normalization,
preserved contact/coordinate fields and same-name party multiplicity. The admin passed 27
targeted tests, lint, production build, architecture/contracts checks and all six
full CI gates.

The live page shows 500 tours in its bounded current/upcoming window. Past-only
also loads correctly. Exact search for `7602L 4`, a departure outside the default
window, returns its valid 6–11 December dates. A search without matches gives an
empty-date-view message rather than claiming the database contains no tours.
UK calendar boundaries are shared by query and filtering and refresh on an open
page each minute and on window focus. Native device display and the next
automatically scheduled morning execution have not yet been observed.
