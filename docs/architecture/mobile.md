# Mobile architecture

Notification OS state, token rotation and server reconciliation are owned by the single-flight
notification registration coordinator. Routine preference saves never prompt. Notification tap
handling validates the canonical payload, expiry, tour/role authority and exact detail route before
persisting its bounded handled key. Future-tour marketing uses the persistent Firebase installation
Auth UID and remains separate from operational app-session authority.

`App.js` delegates to `src/app/AppRoot.js`. `AppRoot` owns providers; `AppShell` coordinates state; runners and hooks own login, restore, logout, notification, offline, and assignment workflows. `AppScreenRouter` renders the stable route registry.

Account deletion is a separate blocking lifecycle, not an expanded logout. The service generates an
opaque receipt and captures the validated original Auth UID in a secure schema-v3 local record before
requesting deletion. It sends only the receipt and exact app-session ID, never the local cleanup UID,
then discards the session ID after server acceptance. Runners purge the captured UID's scoped local data,
persist a local-only `commit_prepared` write-ahead marker, and only then clear ordinary session keys,
replace Auth with a fresh anonymous installation and resume receipt-only status polling across startup,
reconnect and foreground transitions. While a receipt is pending, routing stays on the deletion status
screen and all normal login/tour restoration remains blocked. See `docs/data-contracts/account-deletion.md`.

Screens are compatibility entries or bounded controllers. Controllers own lifecycle and orchestration, views receive state/actions, pure presentation modules format data, and repositories hide Firebase. Large features are split by actual responsibility: chat delivery/search/moderation/media/read state, gallery listing/upload/viewing, itinerary edit/sync/rendering, driver location, boarding, passenger home, notifications, and safety.

Rules:

- Never derive passenger identity on-device. Use the server-issued `pax_v2_…` principal and `app_sessions` authority.
- Never derive or submit account-deletion booking, tour, principal, driver, media, chat or Storage
  scope on-device. Preserve the secure receipt and local-only original Auth UID through initial cleanup;
  clear both only after confirmed completion and final local cleanup.
- Keep route names and screen prop contracts stable.
- Subscribe once per scope and always return cleanup.
- Keep Firebase, fetch, AsyncStorage, and SecureStore out of visual components.
- Map structured service reason codes to safe copy at the feature boundary.
- Treat `DRIVER_POLICY_CHANGE_IN_PROGRESS` as retriable sign-in maintenance and show
  “Driver sign-in settings are being updated. Please try again.”
- Bind live location, presence, and typing writes to the memoized current app-session
  scope. A lifecycle may arm disconnect cleanup only for its own private leaf.
- Prefer pure models for dates, pickup presentation, pagination merges, and action decisions.
- Add a focused behavior test before changing a compatibility entry.

To add a route, create the screen/controller, add exactly one renderer in `src/app/navigation/routeRenderers.js`, pass only required context, and extend route characterization tests.
