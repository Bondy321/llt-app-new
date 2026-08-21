# Driver Command Centre and operations visibility (Gates 8–9)

## Ownership boundaries

The Command Centre is a read-only operational composition. It does not create a new source of truth:

| Information | Authority |
| --- | --- |
| Tour, pickup, passenger, seat, hotel, service, coach, contact and itinerary facts | `driver_tour_packs/{departureKey}` |
| Pending, boarded and no-show state | `tour_manifests/{tourId}` and its complete identity-scoped device cache |
| Pack lifecycle and quality shown to operations | `driver_tour_pack_admin_status/{departureKey}` |
| Driver assignment | Canonical driver/tour assignment links; pack access is still enforced by the manifest assignment link |
| Driver progress and acknowledgements | Reserved for Gate 10 under `driver_tour_pack_actions`; not written by Gates 8–9 |

Every join uses `departureKey = YYYY-MM-DD::NORMALIZED_TOUR_ID`. Display names are never identity keys. A pack and the active driver assignment must agree before the Command Centre describes the tour as confirmed.

## Mobile shell

The shell has four stable sections:

- **Overview**: exact departure confirmation, offline readiness, manifest source, next future event, unresolved fact count, boarding total and quality warnings.
- **Run**: ordered pickup stops with manifest-derived boarded/pending/no-show/unresolved totals, followed by the unified report timeline.
- **People**: report passengers grouped by pickup, manifest-derived state, approved booking-lead call actions, actual-label coach layout and an accessible list alternative.
- **Tour**: hotels with available call/directions actions, services and references, coach/operational contacts, client itinerary and clearly marked confidential driver itinerary.

Seat state is always written as text as well as colour: `Empty`, `Pending`, `Boarded`, `No-show`, `Unmatched` or `Conflict`. Conflict policy suppresses the visual layout while preserving the accessible list. Interactive controls have a minimum 48-point height and explicit accessibility roles, labels and selected/disabled state.

The existing authoritative Passenger Manifest remains the only boarding control. Existing chat, location and safety surfaces are linked from Overview and retain a return path to the Command Centre.

## Operations status projection

The ingestion Function writes a separate fixed-schema, PII-free record at `driver_tour_pack_admin_status/{departureKey}` in the same final multi-location publication as the pack. Allowed data is limited to departure identity, lifecycle status, quality state, revision, source/publication/expiry timestamps and run ID. It contains no passenger, seat, pickup, hotel, contact, itinerary, count or fingerprint payload.

The app operations portal reads only the most recent 2,000 status records using the indexed `publishedAtMs` query. This is bounded above two maximum-size 1,000-pack publication cohorts. An at-limit warning prevents operators from treating an omitted historical row as proof of publication failure. Tours join to status only by exact tour ID plus valid start date. Invalid or ambiguous identity is shown, never guessed.

Each tour shows ready/degraded/stale/cancelled/withdrawn/expired/missing state, semantic revision, last publication time and assignment-versus-pack coverage. Canonical assignment links that disagree are shown as inconsistent; a legacy driver name alone is not treated as authorization coverage.

The management dashboard remains the richer dispatch control surface. It shows report delivery freshness, reconciliation totals, projection state, current publication result, actual server-planned revisions, the durable last successful app publication, and a safe per-departure degraded/blocked/withheld queue with explicit reason codes. General dashboard views never receive driver pack payloads.

## Rollback

Mobile exposure is controlled by exact boolean leaves under `driver_tour_pack_feature_flags`. Set `global` false/delete it to stop global exposure, or false/delete one coherent driver's leaf to remove a canary. The live listeners fail closed and an open Command Centre returns to Driver Home. This rollback does not delete or mutate manifests, report packs or driver actions.

Publisher, Function invoker, rules, web-admin hosting, management-dashboard hosting and OTA mobile rollout remain independently reversible as described in the ingestion and release runbooks.

## Focused release evidence

Before a production release, verify:

1. Exact feature-flag and admin-status Firebase rules in the emulator.
2. Pack/manifest composition, next-event selection, stop progress and unresolved deduplication tests.
3. Cache-first Command Centre behavior and accessible seat/status rendering.
4. PII-recursive projection tests plus fixed admin-status allowlist tests.
5. Exact departure matching, assignment coverage and bounded admin query tests.
6. Management report-freshness, queue, publication and server-revision tests.
7. Web/mobile production builds, responsive rendered QA, then one complete repository test matrix.
