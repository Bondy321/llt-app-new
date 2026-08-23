# Safety delivery contract

This contract covers passenger and driver safety reports, SOS handoff, callback requests, offline replay, operations visibility, assigned-driver notification, trusted contacts, and voluntary live-location sharing.

## Emergency boundary

- The app never calls `999`, operations, a driver, or a trusted contact without a deliberate user action.
- Holding SOS starts a five-second cancellable countdown and then opens emergency actions immediately.
- Assistive-technology activation offers an explicit confirmation that starts the same cancellable countdown; SOS is not dependent on a touch long-press.
- GPS capture and Firebase submission run independently of the dialler options. A slow network or permission prompt must never delay access to emergency calling.
- SOS copy must state that the app does not contact emergency services automatically.
- Only the primary trusted contact is offered in the first emergency action sheet. The text option remains available without GPS and clearly says location is unavailable. Opening the SMS composer does not send the message; the user reviews and sends it.
- After emergency options open, a persistent non-blocking status distinguishes an operations alert that was sent, saved for retry, or not saved.

## Canonical submission path

New clients submit reports to the authenticated `submitSafetyReport` HTTPS Function in `europe-west1`.

The client creates one `clientEventId` before the first network attempt. The same ID survives timeout, offline storage, replay, and an ambiguous acknowledgement. The Function:

1. verifies the Firebase bearer token;
2. normalizes the tour key and validates all bounded input;
3. verifies that the caller is an attached passenger or coherently assigned driver for that role;
4. serializes work under `safety_submission_locks/{tourId}/{clientEventId}`;
5. treats an existing matching event as an idempotent success;
6. writes the private history, tour operations alert, critical global mirror, and lock release in one root update.

Submission abuse quotas are authoritative Realtime Database transactions under opaque
`safety_rate_limits/v1/*` keys scoped to the authenticated UID. They are shared by every
Functions instance and do not trust client-supplied network identifiers.

Canonical version 2 records include:

- `schemaVersion: 2`
- `eventId` and `clientEventId`, both equal to the Firebase event key
- `tourId`
- `reporterAuthUid`, `userId`, and canonical `principalId`
- `role`, `category`, `severity`, `message`, optional bounded `customMessage`
- optional bounded `coords`
- `isSOS` and `status: pending`
- server-owned `timestamp`, `timestampMs`, `receivedAt`, and `receivedAtMs`
- preserved `clientCreatedAt` and `clientCreatedAtMs`
- `processedFromQueue`

Critical and SOS reports are mirrored to `globalSafetyAlerts/{eventId}`. All reports are written to:

```text
logs/{reporterAuthUid}/safety/{eventId}
tours/{tourId}/safetyAlerts/{eventId}
```

All mobile writes to `tours/{tourId}/safetyAlerts` and `globalSafetyAlerts` are denied. Existing
legacy records remain readable and operations-admin mutable, but new reports must pass through
the authenticated Function so normalization, authorization, idempotency, and quotas cannot be
bypassed.

## Offline behavior

- Offline reports are stored in durable AsyncStorage and scoped by tour, principal, and role.
- The queue is capped at 250 records and retains critical/SOS records before routine reports.
- Replay is single-flight per session scope and re-reads the queue before reconciliation so new reports are never lost.
- App startup, reconnect, and foreground refresh replay the active session's safety queue even when the Safety screen is closed.
- A report is removed only after the Function returns success, including `alreadySubmitted: true` after an ambiguous acknowledgement.
- Retryable failures use bounded exponential backoff. Permanent authorization or schema rejection remains durable, stops automatic retry loops, and is surfaced as needing attention with a manual retry action.
- The UI distinguishes `submitted` from `saved for retry`. A persistence failure must surface as `Report Not Saved`.

## Notification and operations handling

`sendSafetyAlertNotification` triggers on new tour safety alerts. It sends privacy-preserving push copy to:

- coherently assigned driver auth users;
- the primary operations admin;
- delegated `admin_users` that also have an eligible mobile push profile.

Safety delivery does not use a user opt-out: these are operational alerts, not marketing. The reporter is excluded, duplicate tokens are removed, invalid tokens are cleaned up safely, and free-text incident details never appear on the lock screen. Delivery acceptance counts are written back to the tour/global alert mirrors.

The web admin reads both tour and global mirrors, deduplicates them by `eventId`, displays sanitized summaries, and updates all known mirrors plus the reporter's private status in one root update.
Mobile report history uses that private status mirror to show submitted, acknowledged, in-progress, escalated, and resolved state without exposing operations-only details.

## Driver callback requests

Passengers cannot write to internal driver chat. The callback action therefore submits a `custom` medium-severity safety event with a bounded generic message. A successful online response means the request is operations-visible and eligible assigned drivers have entered notification fanout; an offline response means it is durably saved for replay.

## Trusted contacts

- Contacts are local to the canonical passenger/driver principal.
- Writes are serialized, limited to five records, and validate bounded names and dialable phone numbers.
- The screen reports storage failures and never claims an add/remove succeeded when persistence failed.
- Trusted contacts are never uploaded as part of a safety report.

## Live-location sharing

Version 2 records live at:

```text
tours/{tourId}/liveTracking/{authUid}
```

They require owner authentication, bounded latitude/longitude/accuracy, a Firebase server timestamp, and a bounded client timestamp. Sharing registers an RTDB `onDisconnect().remove()` cleanup before publishing. Deliberate stop removes the record first and cancels the disconnect handler only after deletion succeeds. A failed delete therefore leaves privacy cleanup armed and the UI does not falsely claim that server sharing stopped. The exact enabled tour/user scope is retained for identity changes and unmount.

## Release order

For contract changes, deploy Functions first, then Realtime Database rules, then publish the mobile update. Run focused service/Function tests, the complete emulator rules matrix, the full repository suite, Expo Doctor/export, and rendered smoke testing before release.
