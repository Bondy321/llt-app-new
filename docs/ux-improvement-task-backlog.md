# LLT App UX Improvement Backlog (Implementation-Ready)

This backlog is prioritized for **user experience impact** (clarity, speed, reliability, confidence), not security hardening. Tasks are structured so each can be implemented independently but still account for cross-repo coupling (mobile app, web-admin, services, and functions).

## How this backlog was derived

Repository areas reviewed:
- Mobile shell/navigation/session: `App.js`
- Passenger/driver core screens: `screens/LoginScreen.js`, `screens/TourHomeScreen.js`, `screens/DriverHomeScreen.js`, `screens/PassengerManifestScreen.js`, `screens/ChatScreen.js`, `screens/ItineraryScreen.js`, `screens/DriverItineraryScreen.js`, `screens/MapScreen.js`, `screens/NotificationPreferencesScreen.js`, `screens/PhotobookScreen.js`, `screens/GroupPhotobookScreen.js`
- Business/offline services: `services/offlineSyncService.js`, `services/chatService.js`, `services/bookingServiceRealtime.js`, `services/offlineLoginResolver.js`, `services/pickupTimeParser.js`, `services/itineraryDateParser.js`, `services/notificationService.js`
- Reusable UI: `components/TodaysAgendaCard.js`, `components/ManifestBookingCard.js`, `components/ImageViewer.js`
- Web admin ops flow: `web-admin/src/components/Dashboard.jsx`, `web-admin/src/components/ToursManager.jsx`, `web-admin/src/components/DriversManager.jsx`, `web-admin/src/components/BroadcastPanel.jsx`, `web-admin/src/services/tourService.js`
- Backend notification bridge: `functions/index.js`

---

## Priority 0 — UX Foundations (Do first)

## Task 1 — Introduce a Global “Connectivity + Sync” UX contract

### Why this is vital
Users currently see banners in multiple places and can’t always tell if the app is merely offline, Firebase-disconnected, or queue-delayed. This creates uncertainty around whether actions actually succeeded.

### Scope
1. Define a single source of truth for sync state labels and severity levels.
2. Standardize copy and iconography across App shell + in-screen refresh banners.
3. Add an explicit “Last successful sync” relative timestamp component used everywhere.
4. Distinguish three states clearly:
   - Offline (no network)
   - Online but backend degraded
   - Online + backlog pending

### Files likely to change
- Mobile shell/state: `App.js`, `hooks/useDiagnostics.js`, `services/offlineSyncService.js`
- In-screen status surfaces: `screens/TourHomeScreen.js`, `screens/ChatScreen.js`, `screens/DriverHomeScreen.js`
- Theme tokens for status colors: `theme.js`

### Cross-repo dependency checks
- Ensure wording parity in web-admin live status chips on `Dashboard.jsx` for internal ops alignment.

### Acceptance criteria
- Same status language appears in app-level and screen-level banners.
- Every manual refresh entry point shows outcome in consistent format: `X synced / Y pending / Z failed`.
- Users can always see when data was last known-good.

### Tests to add/update
- `tests/offlineSyncService.test.js`
- `tests/manifestSyncState.test.js`
- Add new UI-state unit tests around status label mapping.

---

## Task 2 — Simplify Login cognitive load + improve first-success path

### Why this is vital
`LoginScreen` currently has strong functionality, but first-time users can still hesitate due to mixed passenger/driver guidance and dense offline helper text.

### Scope
1. Introduce segmented mode hinting without adding friction:
   - Auto-detect remains, but UI presents “Passenger / Driver” hint chips and context-sensitive placeholders.
2. Progressive disclosure for offline help:
   - Show compact reason headline first; expand detailed recovery steps only on tap.
3. Add inline field validation timing improvements:
   - Validate email format only after blur or submit to reduce noisy errors.
4. Post-login success interstitial:
   - 1–2 second “Tour synced / entering dashboard” state to reduce abrupt transitions.

### Files likely to change
- `screens/LoginScreen.js`
- `screens/loginFlow.js`
- `App.js` (transition handling)
- `services/offlineLoginResolver.js`

### Cross-repo dependency checks
- If driver onboarding wording changes, align naming in web-admin `DriversManager.jsx` so support staff language matches app language.

### Acceptance criteria
- Fewer visible fields/instructions at first glance.
- Offline rejection reasons remain available but less intimidating.
- Measurable drop in immediate login retries after first failure.

### Tests to add/update
- `tests/loginFlow.test.js`
- `tests/offlineLoginResolver.test.js`
- `tests/validateBookingReference.passengerVerifier.test.js`
- `tests/validateBookingReference.driver.test.js`

---

## Task 3 — Restructure Tour Home around “What should I do now?”

### Why this is vital
`TourHomeScreen` is rich but high-density; the most relevant next action (pickup timing, chat updates, itinerary changes) should dominate above decorative elements.

### Scope
1. Reorder layout into explicit priority blocks:
   - Immediate status (pickup countdown / driver status)
   - Next action cards (Chat, Itinerary, Map)
   - Secondary modules (photos, support)
2. Replace multiple competing highlights with one primary CTA per context.
3. Add adaptive card ordering based on urgency:
   - If pickup < 2h, map card moves to top.
   - If unread chat exists, chat card gets first position (unless pickup imminent).
4. Add concise “What changed since last open” strip sourced from cached state delta.

### Files likely to change
- `screens/TourHomeScreen.js`
- `components/TodaysAgendaCard.js`
- `services/pickupTimeParser.js`
- `services/offlineSyncService.js` (state diff metadata)

### Cross-repo dependency checks
- Ensure tour changes made in web-admin `ToursManager.jsx` are reflected as meaningful change summaries in mobile home strip.

### Acceptance criteria
- Top 1–2 cards always answer user’s immediate need.
- No duplicate urgency visuals fighting for attention.
- Change-strip shows itinerary/driver/pickup updates reliably after sync.

### Tests to add/update
- `tests/pickupTimeParser.test.js`
- Add decision-matrix tests for card priority ordering.

---

## Priority 1 — Communication & Driver Operations

## Task 4 — Chat performance pass for long tours + media-heavy threads

### Why this is vital
`ChatScreen` is feature-rich (reactions, typing, presence, media), but long threads risk sluggishness and scroll instability.

### Scope
1. Migrate message rendering from `ScrollView` pattern to virtualized list strategy.
2. Introduce pagination windows:
   - initial recent window
   - pull-up to load older messages
3. Stabilize unread separator behavior when new messages stream in.
4. Make media upload state explicit in-message:
   - queued, uploading, failed, retrying.
5. Improve “jump to latest” affordance when user is scrolled far up.

### Files likely to change
- `screens/ChatScreen.js`
- `services/chatService.js`
- `services/offlineSyncService.js`
- `__tests__/chatService.test.js`
- `__tests__/offlineQueueing.test.js`

### Cross-repo dependency checks
- If broadcast/chat payload structure is changed, verify notification parsing in `functions/index.js` and web-admin `BroadcastPanel.jsx`.

### Acceptance criteria
- Smooth scrolling on large histories.
- Predictable unread marker placement.
- Image/message queue state is always visible and recoverable.

---

## Task 5 — Driver manifest flow: speed up boarding actions by 2–3 taps

### Why this is vital
Boarding is time-critical. Drivers need fewer taps, faster search, and better confidence that updates are synced.

### Scope
1. Add sticky quick filters in manifest:
   - Pending, Boarded, No-show, Partial.
2. Add large, one-tap status actions on each row (with undo snackbar).
3. Support bulk action mode for coach loading moments.
4. Add resilient optimistic updates with visible pending markers per booking row.
5. Show lightweight conflict resolution if server data supersedes local action.

### Files likely to change
- `screens/PassengerManifestScreen.js`
- `components/ManifestBookingCard.js`
- `services/bookingServiceRealtime.js`
- `services/offlineSyncService.js`
- `utils/manifestSyncState.js`

### Cross-repo dependency checks
- Mirror status semantics in web-admin tour views (`ToursManager.jsx`) so ops team sees same parent/child status interpretation.

### Acceptance criteria
- Core boarding operation can be completed in one interaction from filtered list.
- Drivers can recover from mistaken taps quickly (undo window).
- Pending/failed/synced state per booking is obvious.

### Tests to add/update
- `tests/passengerManifestSyncLabels.test.js`
- `tests/joinTour.test.js` (if shared status derivation logic is touched)
- `tests/manifestSyncState.test.js`

---

## Task 6 — Driver Home command-center redesign

### Why this is vital
Driver users are operational users under time pressure. Primary actions should be immediate and context-bound to the active tour.

### Scope
1. Rebuild top section to show active tour lock + next operational deadlines.
2. Introduce “today’s operations rail” with 3 prioritized actions:
   - Boarding
   - Driver chat (internal)
   - Itinerary adjustments
3. Add explicit inactive-state UX when no assigned tour exists:
   - next steps, assignment check, refresh guidance.
4. Replace scattered alerts with structured status panel (assignment, sync, notifications).

### Files likely to change
- `screens/DriverHomeScreen.js`
- `App.js` (driver assignment/session refresh behavior)
- `services/bookingServiceRealtime.js`

### Cross-repo dependency checks
- Validate that admin assignment actions in `web-admin/src/components/DriversManager.jsx` produce immediate driver-home state update after sync.

### Acceptance criteria
- Driver can reach manifest or internal chat in one tap from landing.
- Unassigned state has no dead-end confusion.

---

## Priority 2 — Itinerary, Map, and Notifications coherence

## Task 7 — Create a shared timeline model for Itinerary + Map + Agenda

### Why this is vital
Time/date handling appears across multiple screens/services. A shared “timeline event” model reduces conflicting displays and improves trust.

### Scope
1. Build a normalized timeline adapter for itinerary + pickup points.
2. Use one formatting pipeline for:
   - itinerary cards
   - map pickup ETA labels
   - home agenda snippets
3. Add clear unsupported-date fallback labels (non-breaking, actionable).
4. Introduce timezone badge (“Local tour time”) where ambiguity exists.

### Files likely to change
- `screens/ItineraryScreen.js`
- `screens/DriverItineraryScreen.js`
- `screens/MapScreen.js`
- `components/TodaysAgendaCard.js`
- `services/itineraryDateParser.js`
- `services/pickupTimeParser.js`
- `services/timeUtils.js`

### Cross-repo dependency checks
- Validate web-admin date entry/editor in `ToursManager.jsx` and `web-admin/src/utils/dateUtils.js` to ensure authored dates always map cleanly to mobile timeline adapter.

### Acceptance criteria
- Same event appears with same day/time semantics on all screens.
- Unsupported formats degrade gracefully with clear messaging.

### Tests to add/update
- `tests/itineraryDateParser.test.js`
- `tests/timeUtils.test.js`
- `tests/pickupTimeParser.test.js`

---

## Task 8 — Notification preferences + in-app inbox harmonization

### Why this is vital
Users can miss critical tour updates if settings feel unreliable or if push-only delivery fails silently.

### Scope
1. Improve `NotificationPreferencesScreen` state UX:
   - explicit loading skeleton
   - stale values indicator
   - “last saved” confirmation
2. Add lightweight in-app notification center (recent events) as fallback when push delivery fails.
3. Categorize events:
   - chat
   - itinerary
   - broadcast/ops alert
4. Add per-category mute durations (e.g., mute chat for 1 hour).

### Files likely to change
- `screens/NotificationPreferencesScreen.js`
- `services/notificationService.js`
- `services/offlineSyncService.js` (cache recent notifications)
- Possibly new screen/component under `screens/` or `components/`
- Backend routing in `functions/index.js`

### Cross-repo dependency checks
- Align with web-admin broadcast sending UX in `BroadcastPanel.jsx` so category metadata is emitted and consumed consistently.

### Acceptance criteria
- Users always know whether preferences are saved.
- Important events remain discoverable in-app even if push fails.

---

## Priority 3 — Media & Web Admin operational UX

## Task 9 — Photobook and Group Photo quality-of-life upgrade

### Why this is vital
Photo flows are emotional/high-engagement surfaces; small UX improvements materially increase perceived app value.

### Scope
1. Add upload progress and retry controls directly in gallery grid.
2. Add basic sort/filter (newest, oldest, mine only).
3. Add image prefetch/thumbnails for faster opening in `ImageViewer`.
4. Add optional caption edit after upload.
5. Improve empty/offline states (what user can still do now).

### Files likely to change
- `screens/PhotobookScreen.js`
- `screens/GroupPhotobookScreen.js`
- `components/ImageViewer.js`
- `services/photoService.js`
- `services/offlineSyncService.js` (queued uploads metadata)

### Cross-repo dependency checks
- If metadata schema expands (caption/edit timestamps), verify any admin/reporting display in web-admin does not break if reading photo nodes in future tooling.

### Acceptance criteria
- Upload progress visible per photo.
- Failed uploads can be retried without leaving screen.
- Image viewer opens near-instantly for cached thumbnails.

### Tests to add/update
- `__tests__/photoService.test.js`

---

## Task 10 — Web-admin “operator confidence” improvements that directly improve rider UX

### Why this is vital
Mobile UX quality depends on operational data quality. Admin users need frictionless data authoring and clarity on what mobile users will experience.

### Scope
1. Add “mobile impact preview” in Tours Manager:
   - show how pickup times, itinerary titles, and driver assignment will appear in app.
2. Add date/time validation inline with plain-language errors before save/import.
3. Improve Dashboard triage cards to highlight tours at risk of user confusion:
   - unassigned driver close to departure
   - malformed date/time fields
   - low sync confidence indicators
4. Add Broadcast panel templates (service delay, pickup change, emergency note) with preview.

### Files likely to change
- `web-admin/src/components/ToursManager.jsx`
- `web-admin/src/components/Dashboard.jsx`
- `web-admin/src/components/BroadcastPanel.jsx`
- `web-admin/src/services/tourService.js`
- `web-admin/src/utils/dateUtils.js`
- Possibly `functions/index.js` for broadcast payload metadata

### Mobile-side companion changes (must be included)
- `screens/TourHomeScreen.js` and `screens/ChatScreen.js` to render richer broadcast metadata consistently.
- `services/itineraryDateParser.js` / `services/pickupTimeParser.js` if date constraints are tightened.

### Acceptance criteria
- Admin can see exactly how edits will surface on passenger/driver screens.
- Invalid schedule data is blocked early with actionable fixes.

### Tests to add/update
- `web-admin/src/components/ToursManager.test.jsx`
- `web-admin/src/utils/triageUtils.test.js`
- `tests/tourCsvService.test.js`

---

## Execution order recommendation

1. Task 1 (Sync contract)
2. Task 2 (Login simplification)
3. Task 3 (Tour Home IA)
4. Task 5 (Manifest speed)
5. Task 6 (Driver Home command center)
6. Task 4 (Chat performance)
7. Task 7 (Shared timeline model)
8. Task 8 (Notifications + inbox)
9. Task 9 (Photobook QoL)
10. Task 10 (Web-admin operator confidence + mobile parity)

---

## Definition of done (applies to every task)

- Feature-level UX copy reviewed for clarity and consistency.
- Empty/loading/error/offline states all implemented (not just happy path).
- Mobile + web-admin coupling validated where data schema or semantics changed.
- Existing tests pass and task-specific tests added.
- Release note entry added for operations/support teams.
