# Driver Assignment Data Contract

## Canonical node

`tour_manifests/{tourId}/assigned_driver_codes/{driverId}`

## Canonical payload shape

```ts
interface AssignedDriverCodeRecord {
  tourId: string;      // sanitized Firebase key, e.g. "5112D_8"
  tourCode: string;    // human code, e.g. "5112D 8"
  assignedAt: string;  // ISO-8601 timestamp, e.g. "2026-02-01T10:15:00.000Z"
  assignedBy: string;  // actor identifier (Firebase UID or system actor key)
}
```

## Field requirements

- `tourId`: required, non-empty string.
- `tourCode`: required, non-empty string.
- `assignedAt`: required, ISO-8601 UTC timestamp string.
- `assignedBy`: required, non-empty string actor identifier.

## Backward compatibility (temporary)

Legacy values may still appear as a plain string (`"D-BONDY"` or a tour code-like value) for older writes. Readers must:

1. treat object payload above as canonical;
2. tolerate string payloads temporarily;
3. never write string payloads going forward.

## Producers

- Mobile: `services/bookingServiceRealtime.js` (`assignDriverToTour`)
- Web Admin: `web-admin/src/services/tourService.js` (`buildDriverAssignmentUpdates`)

Both producers must emit **identical key names and casing** for canonical payload writes.
