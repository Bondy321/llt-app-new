# Tour Identity Data Contract

Use this contract for creating and updating tours across mobile, web-admin, and imports.

## Canonical identity

- `tours/{tourId}` is keyed from the human tour code with `generateTourId`-style normalization.
- `tourCode` is the display code stored on the tour record.
- For normal web-admin-created tours, these values must refer to the same identity:
  - `tourCode`: `5112D 8`
  - `tourId`: `5112D_8`

Mobile services commonly derive `tourId` from `tourCode` before reading `tours/{tourId}` and `tour_manifests/{tourId}`, so web-admin must not let the display code drift away from the Firebase key.

## Creation rules

- `tourCode` is required.
- Creating a tour uses a Realtime Database transaction that commits only when
  `tours/{generateTourId(tourCode)}` is absent, so concurrent administrators
  cannot overwrite one another with the same code.
- Duplicate/copy flows must generate a fresh code before writing.
- Do not overwrite an existing `tours/{tourId}` node as a side effect of creating a tour.

## Update rules

- `tourCode` is immutable after creation.
- Edit flows should omit `tourCode` from normal updates.
- Service-level update helpers must reject writes that attempt to change an existing tour's identity.
- Updates first confirm that the target still exists and validate partial date
  patches against the stored counterpart; `update()` must never synthesize a
  partial ghost tour after a stale UI action.

## Copy, CSV, and deletion rules

- Duplicate flows copy only reusable definition fields: dates, capacity, pickup points, client/driver itineraries, active state, duration, and name.
- Duplicate flows must never copy participants, passenger counts, driver assignment, safety alerts, live tracking, driver location, or other operational state.
- CSV updates are patches. A missing column preserves the existing field, and CSV import must never synthesize an empty itinerary for an existing tour.
- CSV dates are normalized to `dd/MM/yyyy`; pickup points use a JSON array in exports and accept the legacy `HH:mm - location` format on import.
- CSV driver changes require a canonical existing `Driver ID`. Display-only driver name/phone columns never create an assignment.
- Tour deletion runs through the authenticated `deleteTourData` Function. It removes the tour, manifests, bookings and identities, access grants, pickup indexes, chats, broadcasts, safety mirrors, reports, driver assignment links, photo metadata, and both group/private Storage objects.
- Tour deletion is retry-safe after a lost response: when the primary tour node
  is already absent, the Function repeats deterministic branch/Storage cleanup
  and returns success with `alreadyDeleted: true`.
- Historical `logs` and `ops_alerts` are retained as operational audit records and are not tour-owned content.
