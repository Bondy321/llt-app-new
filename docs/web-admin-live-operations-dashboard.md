# Web Admin Live Operations Dashboard

Last updated: May 28, 2026

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

## Derived Metrics

Driver coverage:

- A tour is treated as assigned when its tour driver fields, a driver `currentTourId`/legacy `activeTourId`, or manifest `assigned_drivers`/`assigned_driver_codes` indicates coverage.
- Upcoming coverage is calculated for active tours with valid start dates in the dashboard attention window.
- Unassigned queue entries are active tours due soon or recently overdue without detected driver coverage.

Passenger load:

- Passenger count prefers `tours/{tourId}/currentParticipants`.
- If that is missing, it falls back to `tours/{tourId}/participants`.
- If both are missing, it falls back to passenger-like counts in `tour_manifests/{tourId}/bookings`.
- Capacity percentages are shown only when `maxParticipants` is present and positive.

Safety:

- Safety rows combine `globalSafetyAlerts` and `tours/{tourId}/safetyAlerts`.
- Duplicate global/tour safety records are merged by `eventId` when available.
- Status actions update every merged Firebase path with safe admin metadata.

Broadcasts:

- Broadcast activity is derived from `broadcasts/{tourId}/{broadcastId}`.
- The dashboard displays message summaries, tour IDs, sources, and timestamps only.
- It never displays `createdByUid`.

## Actions And Links

- Ops alerts can be acknowledged or resolved through `ops_alerts/{fingerprint}`.
- Safety alerts can be acknowledged or resolved through their merged safety paths.
- Tour links navigate to `/tours?q={tourId}`.
- Unassigned queue links navigate to `/tours?status=unassigned` and may include `q`.
- Broadcast actions navigate to `/broadcast`.

## Privacy Boundary

Dashboard summaries must sanitize free text before display. Do not show booking references, emails, auth UIDs, push tokens, raw session IDs, tokens, passwords, raw coordinates, or raw user IDs. Prefer masked summaries and aggregate counts.
