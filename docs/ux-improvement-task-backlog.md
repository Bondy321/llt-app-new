# UX Reliability + Improvement Backlog

Last refreshed: February 2026.

This document tracks shipped UX hardening work and next execution priorities for mobile + web-admin.

## Recently shipped (high impact)

### Sync + refresh clarity

- Canonical sync taxonomy adopted across app shell and screens:
  - `OFFLINE_NO_NETWORK`
  - `ONLINE_BACKEND_DEGRADED`
  - `ONLINE_BACKLOG_PENDING`
  - `ONLINE_HEALTHY`
- Manual refresh surfaces now use one deterministic copy contract:
  - `"{X} synced / {Y} pending / {Z} failed"`
- Chat and Tour Home pull-to-refresh now execute real queue replay and surface outcomes.

### Chat reliability

- Chat open + return-to-bottom flows now mark read state more reliably (tour + internal driver chat).
- Pull-to-refresh sync outcomes moved from disruptive alerts to in-screen banners with retry affordance.
- Clipboard copy path updated to `@react-native-clipboard/clipboard` compatibility.

### Notification preferences resilience

- Missing `userId` and fetch failures no longer trap spinner/loading states.
- Empty/error states now include retry/recover affordances.

### Driver + passenger context consistency

- Passenger live bus indicator now listens to canonical path: `tours/{tourId}/driverLocation`.
- Driver reassignment now updates in-memory + persisted session context immediately (no forced re-login).

### Date/time parsing hardening

- Pickup countdown supports `HH:mm` and `h:mm AM/PM` variants.
- Itinerary start-date parser now accepts explicit UK/ISO only and guards unsupported values.

## Current priorities (next sprint)

1. **Offline-first itinerary + ticketing polish**
   - Expand cache hydration feedback and stale-data indicators.
2. **Driver manifest conflict transparency**
   - Richer UI detail when server wins a reconciliation.
3. **Unified sync diagnostics panel**
   - Optional detail drawer for queue depth, last sync, and failed action reasons.
4. **Accessibility pass**
   - Screen reader labels, touch target audit, and contrast checks on banners/status chips.
5. **Web-admin operational feedback polish**
   - Consistent inline feedback for assignment + broadcast operations.

## Backlog candidates

- Quiet-hours notification preferences.
- Grouped push notification presentation by tour context.
- Driver shift-focused status cues in driver home.
- Additional empty-state coaching for first-time passenger sessions.

## Acceptance criteria template (for new UX tasks)

- Uses existing theme tokens (no hardcoded colors/spacing).
- Uses canonical sync state + summary formatter where refresh/sync appears.
- Includes offline behavior notes (if relevant).
- Includes at least one deterministic unit/integration test update.
- Includes user-facing fallback copy for error/empty states.
