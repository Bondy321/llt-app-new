# Driver Assignment Data Contract

Use this contract for all driver-to-tour assignment writes (mobile + web-admin).

## Canonical nodes involved

- `drivers/{driverId}`
- `tour_manifests/{tourId}/assigned_drivers/{driverId}`
- `tour_manifests/{tourId}/assigned_driver_codes/{driverId}`

Assignments must be written as one multi-path update to keep these nodes consistent.

## Canonical payload shape

```ts
interface AssignedDriverCodeRecord {
  tourId: string;      // sanitized Firebase key, e.g. "5112D_8"
  tourCode: string;    // human-readable code, e.g. "5112D 8"
  assignedAt: string;  // ISO timestamp, e.g. "2026-02-01T10:15:00.000Z"
  assignedBy: string;  // actor key/uid
}
```

## Validation requirements

- `tourId`: required, sanitized Firebase-safe key.
- `tourCode`: required non-empty display code.
- `assignedAt`: required ISO datetime with timezone.
- `assignedBy`: required non-empty actor identifier.

## Compatibility window

Legacy string values may still exist under `assigned_driver_codes/{driverId}`. Readers must:

1. treat the object payload above as canonical,
2. tolerate legacy strings while migration completes,
3. never emit new legacy string writes.

## Producers

- Mobile: `services/bookingServiceRealtime.js` (`assignDriverToTour`)
- Web admin: `web-admin/src/services/tourService.js` (`buildDriverAssignmentUpdates`)

Both producers must emit identical field names and casing.
