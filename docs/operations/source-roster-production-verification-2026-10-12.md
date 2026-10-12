# Source roster recovery verification — 12 October 2026

Today's complete six-report 07:00 batch is published to the primary Loch Lomond Travel RTDB. The 11 October 07:00 TourSummary email was absent, so that execution stopped before writing; the noon report was not mixed into the morning batch. The operator considers this a one-off upstream reporting error and expects the normal reports to resume; the report scheduler's own error history was not available for independent verification. Recovery used the complete 12 October batch, without backdating yesterday's data.

The first 12 October execution stopped safely on two legitimate booking transfers, affecting five passengers across four old/destination tours. Importer PRs [3](https://github.com/Bondy321/llt-app-sync/pull/3) and [4](https://github.com/Bondy321/llt-app-sync/pull/4) add bounded, journalled publication across all affected tours and fresh passenger identities when departure scope changes, including a date A → B → A cycle. Source/manual reference collisions remain errors. Existing boarding records and operational fields are retained; no positional boarding status is carried into a different departure.

App PRs [475](https://github.com/Bondy321/llt-app-new/pull/475) and [476](https://github.com/Bondy321/llt-app-new/pull/476) withdraw former-tour access through passenger HTTP endpoints and all 34 granting native RTDB boundaries, including deletes. Missing-email manual/source bookings cannot use existing passenger sessions. Legacy compatibility still requires a complete, current server-owned passenger identity/session; deleting the profile's booking reference cannot bypass the source scope guard. Driver and admin permissions retain their existing authority.

## Released revisions and deployment

- Importer main: `3fc164b7a24cfc83df2acb3ad0024265d101cef4`. Cloud Build `91ec4824-ae66-4431-9f99-0dcee88a6d4e` succeeded. The existing `llt-app-sync-daily` job is generation 28, pinned to `sha256:72fc1395fb76bca4fe79ed2a8e4404f4d0462f872ada7e41eda9d0b28e065341`. Only its image changed; arguments, secrets, one task, one retry and 60-minute timeout remain unchanged.
- App main for the deployed fixes: `d600adcd7e17254f0c953aa6948622282a2ac903`. All six required CI gates passed on both final reviewed branches and merged main.
- Nine affected non-scheduled passenger HTTP Functions deployed successfully: trip snapshot, private/group photo access/upload/delete, group-photo chat creation and safety submission. Reviewed RTDB rules deployed successfully and the live semantic digest matches `577a4433361886fdfb14482b05a7da9d538b617a7ff2acebbb587000c3924349`.
- No scheduled Functions were deployed. Notification delivery retention remains paused; the 07:10 Europe/London importer remains enabled and old 09:00/13:00 schedules remain paused. The existing import execution-error monitoring policy remains enabled.

Recovery execution `llt-app-sync-daily-l9t7b` succeeded, completing at 10:18:36 UTC in 4m22.81s. It generated 18 itineraries from real changed letters, reused 376 from RTDB and reported zero generation failures. Cloud Run's local success cache is ephemeral; durable cross-execution reuse comes from published RTDB source proofs.

Repeat execution `llt-app-sync-daily-gndtc` succeeded, completing at 11:00:54 UTC in 3m50.80s. All 394 itineraries were reused from RTDB, none were generated and there were zero planned roster update paths. The subsequent complete reconciliation found identical archive content/count, passenger identities and factual roster fingerprints, with zero mismatches and both private transfer journals complete. All five original runtime/history fingerprints remained unchanged.

## Live reconciliation

- All 543 current source tours are ready for report date 12 October: 450 active and 93 source-cancelled/inactive. No publication leases remain held.
- All 5,340 current source bookings and 14,289 occupied passenger occurrences match the source names, seats, departure dates, pickup facts and login eligibility, with zero mismatches. This includes 174 passengers without matching pickup enrichment; pickup reports do not define membership.
- There are 4,999 login-eligible bookings and 341 bookings retained only for the operational roster because no login email exists. No passenger is dropped or assigned a fabricated email/credential.
- 187 absent source bookings remain physically present as `not_in_report`, excluded from current membership and login. There are 5,450 private predecessor snapshots. Original manifest, driver, user, booking-runtime and tour-runtime hashes match the pre-recovery baseline.
- The actual server manifest DTO builder and actual mobile offline-cache replace/read validator passed all 450 active source tours: 5,321 bookings and 14,240 passengers, maximum party 53. There are zero cache rejections, count mismatches or private-field leaks. Cancelled tours retain their source records but deny normal active manifest access.
- Every dashboard booked-place projection agrees with the source/manual count policy. The complete summary agrees with all 2,230 nondeleted projection rows. Its 56,073 passengers are historical/all-time totals, not today's departures.
- Browser verification showed 500 tours in the labelled current/upcoming window, 407 active and 12,925 booked places. Exact-code search reaches tours outside this window: `5235L2 41` shows 50/53 booked on 12 December, and `5146D 28` shows 46/53. Former `5235L 37` is inactive/cancelled with 0/53. Searching an outside-window tour adds that record to the loaded totals, so those are not global counts.
- The live Add Passenger form explicitly accepts a blank login email and explains that this creates an operational roster entry without app credentials. It was closed without entering passenger details or creating a booking.

## Regression evidence and recovery boundaries

Importer coverage includes 135 distinct pure tests and 26 actual SDK cases, with crash/retry publication, shared leases, manual ownership, transfer scope changes, immutable history, cache replacement failure and same-tour date-cycle tests. App coverage includes 93 actual RTDB rules cases, 19 real HTTP scope cases, 36 shared-guard unit cases and static authority-inventory checks. Final required CI checks passed for architecture/contracts, mobile, Functions, Firebase rules, web administration and security.

An incomplete transfer intent is recoverable by replaying its exact attested batch. A pending intent with a different day's receipt fails closed and requires the documented operator reconciliation; never mark a partial tour ready or restore whole booking/manifest records over newer runtime data. See the importer's `docs/authoritative-roster-publication.md` and [source passenger roster contract](../data-contracts/source-passenger-roster.md).

123 active source tours still lack real detailed itinerary letters; the admin shows these gaps explicitly. Accurate upstream content is required for the relevant pilot departure. Physical iOS/Android installation, background tracking, offline boarding and store-candidate acceptance remain separate launch tasks.

Today's source Sold counter is lower than the occupied TourPax roster on 39 active tours, by 84 places in total. TourPerfExtract Pax agrees exactly with TourPax on all 39. This is an upstream counter discrepancy, retained as one validation warning category; the complete operational roster and dashboard count floor are preserved rather than dropping those passengers to match Sold.

Aggregate evidence is outside Git in `C:/Users/sa08b/Documents/App_Full/verification/2026-10-12`, including `live-roster-before.json`, `live-roster-after.json`, `live-roster-repeat.json`, `source-manifest-cache-verification.json`, `booked-policy-check.json`, `dashboard-summary-check.json` and `deployed-rules-verification.json`. Evidence stores counts/fingerprints and tour codes, not passenger details or credentials.
