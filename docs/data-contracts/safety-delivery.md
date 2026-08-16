# Safety delivery contract

This contract covers passenger and driver safety reports, SOS handoff, callback requests, offline replay, operations visibility, assigned-driver notification, trusted contacts, and voluntary live-location sharing.

## Emergency boundary

- The app never calls `999`, operations, a driver, or a trusted contact without a deliberate user action.
- Holding SOS starts a five-second cancellable countdown and then opens emergency actions immediately.
- GPS capture and Firebase submission run independently of the dialler options. A slow network or permission prompt must never delay access to emergency calling.
- SOS copy must state that the app does not contact emergency services automatically.
- Only the primary trusted contact is offered in the first emergency action sheet. Opening the SMS composer does not send the message; the user reviews and sends it.

## Canonical submission path

New clients submit reports to the authenticated `submitSafetyReport` HTTPS Function in `europe-west1`.

The client creates one `clientEventId` before the first network attempt. The same ID survives timeout, offline storage, replay, and an ambiguous acknowledgement. The Function:

1. verifies the Firebase bearer token;
2. normalizes the tour key and validates all bounded input;
3. verifies that the caller is an attached passenger or coherently assigned driver for that role;
4. serializes work under `safety_submission_locks/{tourId}/{clientEventId}`;
5. treats an existing matching event as an idempotent success;
6. writes the private history, tour operations alert, critical global mirror, and lock release in one root update.

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

Legacy unversioned direct writes remain temporarily accepted for already-installed clients, but version 2 client writes are denied so the authoritative Function cannot be bypassed.

## Offline behavior

- Offline reports are stored in durable AsyncStorage and scoped by tour, principal, and role.
- The queue is capped at 250 records and retains critical/SOS records before routine reports.
- Replay is single-flight per session scope and re-reads the queue before reconciliation so new reports are never lost.
- A report is removed only after the Function returns success, including `alreadySubmitted: true` after an ambiguous acknowledgement.
- The UI distinguishes `submitted` from `saved for retry`. A persistence failure must surface as `Report Not Saved`.

## Notification and operations handling

`sendSafetyAlertNotification` triggers on new tour safety alerts. It sends privacy-preserving push copy to:

- coherently assigned driver auth users;
- the primary operations admin;
- delegated `admin_users` that also have an eligible mobile push profile.

Safety delivery does not use a user opt-out: these are operational alerts, not marketing. The reporter is excluded, duplicate tokens are removed, invalid tokens are cleaned up safely, and free-text incident details never appear on the lock screen. Delivery acceptance counts are written back to the tour/global alert mirrors.

The web admin reads both tour and global mirrors, deduplicates them by `eventId`, displays sanitized summaries, and updates all known mirrors plus the reporter's private status in one root update.

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

They require owner authentication, bounded latitude/longitude/accuracy, a Firebase server timestamp, and a bounded client timestamp. Sharing registers an RTDB `onDisconnect().remove()` cleanup before publishing. Deliberate stop cancels the disconnect handler and removes the record. The UI states that sharing lasts while the safety screen is open, and unmount performs a best-effort stop.

## Release order

For contract changes, deploy Functions first, then Realtime Database rules, then publish the mobile update. Run focused service/Function tests, the complete emulator rules matrix, the full repository suite, Expo Doctor/export, and rendered smoke testing before release.
