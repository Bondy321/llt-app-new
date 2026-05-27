# Tour Identity Data Contract

Use this contract for creating and updating tours across mobile, web-admin, imports, and migration helpers.

## Canonical identity

- `tours/{tourId}` is keyed from the human tour code with `generateTourId`-style normalization.
- `tourCode` is the display code stored on the tour record.
- For normal web-admin-created tours, these values must refer to the same identity:
  - `tourCode`: `5112D 8`
  - `tourId`: `5112D_8`

Mobile services commonly derive `tourId` from `tourCode` before reading `tours/{tourId}` and `tour_manifests/{tourId}`, so web-admin must not let the display code drift away from the Firebase key.

## Creation rules

- `tourCode` is required.
- Creating a tour must fail if `tours/{generateTourId(tourCode)}` already exists.
- Duplicate/copy flows must generate a fresh code before writing.
- Do not overwrite an existing `tours/{tourId}` node as a side effect of creating a tour.

## Update rules

- `tourCode` is immutable after creation.
- Edit flows should omit `tourCode` from normal updates.
- Service-level update helpers must reject writes that attempt to change an existing tour's identity.

## Legacy tolerance

Legacy tours may exist where `tourCode` and `{tourId}` do not normalize to the same key. Update flows may preserve the existing code for those records, but must not change it in place. Renaming a tour code requires a deliberate migration that moves all related roots, including `tour_manifests`, bookings, driver assignment helpers, chats, photos, and any cached references.
