# Web Admin Live Operations Dashboard

Last updated: October 10, 2026

The web-admin dashboard is the central live command hub for LLT operations. It must show only data that is backed by Firebase branches or deterministic derived metrics. Do not add placeholder trends, fake percentages, decorative status cards, or controls that do not perform a real action.

## Data Sources

The dashboard listens to these bounded or operational roots:

- `drivers`
- `tours`
- `tour_manifests`
- `globalSafetyAlerts`
- `broadcasts`
- `ops_alerts` through a bounded `lastSeenAtMs` query

It does not subscribe to `/logs`. App and device errors must come from the curated `ops_alerts` layer.

`ops_alerts` is admin-only. A web-admin operator must either be the hardcoded admin UID or have `admin_users/{authUid} = true`; otherwise the rest of the dashboard can load while the app/device error panel is rule-denied.

## Derived Metrics

Driver coverage:

- A tour is treated as assigned when its tour driver fields, a driver `currentTourId`, or manifest `assigned_drivers`/`assigned_driver_codes` indicates coverage.
- Upcoming coverage is calculated for active tours with valid start dates in the dashboard attention window.
- Unassigned queue entries are active tours due soon or recently overdue without detected driver coverage.

Passenger load:

- Booked places prefer the validated `tours/{tourId}/sold` value from TourSummary.
- Fallbacks are `bookedPassengerCount`, then `manifestPassengerCount` from the passenger report, then a positive actual manifest summary, then the legacy `currentParticipants`/participant count. Counts must be nonnegative safe integers; nulls, booleans, fractions and malformed strings are not zero counts.
- A present source zero is authoritative. Runtime membership counters must not override imported totals and are never overwritten by this display/projection policy.
- Tours cards, table, details, edit display, totals and CSV exports use the same browser helper. Report counts are exported in separate read-only columns. Where sold and passenger-list rows differ, the tour explicitly shows the list count for review.
- Dashboard server projections read and react to all three imported count leaves. Every handler that recomputes a tour row must be deployed together; the existing paginated dashboard backfill refreshes historical rows after deployment. Browser/server precedence has a parity regression test.
- Capacity percentages are shown only when `maxParticipants` is present and positive.
- Capacity edits cannot lower the limit below the reported booked places or existing runtime counter.

Safety:

- Safety rows combine `globalSafetyAlerts` and `tours/{tourId}/safetyAlerts`.
- Duplicate global/tour safety records are merged by `eventId` when available.
- Status actions update every merged Firebase path with safe admin metadata.
- Status actions use one root multi-path update so mirrored global/tour records cannot diverge after a partial write.

Broadcasts:

- Broadcast activity is derived from `broadcasts/{tourId}/{broadcastId}`.
- The dashboard reads the `broadcasts` root so it can summarize activity across tours.
- The dashboard displays message summaries, tour IDs, sources, timestamps, and backend delivery status.
- It never displays `createdByUid`.

Broadcast records move through `queued`, `processing`/`chat_queued`, and a terminal `delivered`, `partial`, `no_recipients`, or `failed` state. `delivered` means Expo accepted every eligible push request; it is not a device-display receipt. The composer reports “queued” after the browser write and relies on Functions to publish recipient and acceptance counts.

## Actions And Links

- Ops alerts can be acknowledged or resolved through `ops_alerts/{fingerprint}`.
- Safety alerts can be acknowledged or resolved through their merged safety paths.
- Tour links navigate to `/tours?q={tourId}`.
- Unassigned queue links navigate to `/tours?status=unassigned` and may include `q`.
- Broadcast actions navigate to `/broadcast`.

## Privacy Boundary

Dashboard summaries must sanitize free text before display. Do not show booking references, emails, auth UIDs, push tokens, raw session IDs, tokens, passwords, raw coordinates, or raw user IDs. Prefer masked summaries and aggregate counts.
