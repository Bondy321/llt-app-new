# Chat Delivery Contract

This contract covers group chat, internal driver chat, offline replay, photo messages, and push delivery.

## Canonical paths

- Group: `chats/{tourId}/messages/{messageId}`
- Driver team: `internal_chats/{tourId}/messages/{messageId}`

Presence and typing writes use private per-session sources:

- `chat_presence_sessions/{scope}/{appSessionId}`
- `chat_typing_sessions/{scope}/{appSessionId}`

where `scope` is `group` or `internal`. Each schema-v2 leaf binds its path session,
Auth UID, principal, tour, actor key, role, server timestamp, and bounded expiry to
the exact current app session. Passengers may use only group scope. Drivers require
the same current policy generation and manifest assignment as other driver-only
surfaces.

Retryable backend projections preserve the existing aggregate read paths at
`chats|internal_chats/{tourId}/presence|typing/{actorKey}`. A principal remains
online while any valid presence leaf exists and remains typing while any
non-expired typing leaf exists. Projection revisions prevent delayed events from
regressing the aggregate. Disconnect, unmount, logout, and cleanup remove only the
owning session leaf; a bounded scheduled cleanup removes expired leaves and
reconciles the affected actor.

## Version 2 message

New clients write `schemaVersion: 2`. Every logical send owns one Firebase-safe `messageId`; `idempotencyKey` must equal that path key. Creation uses a transaction that writes only when the path is absent, so a lost acknowledgement, offline replay, or manual retry cannot duplicate or overwrite the message.

Version 2 uses the Firebase server timestamp for canonical `timestamp` ordering and retains positive numeric `clientCreatedAt` for optimistic/offline context. Rules require a server time within one minute of `now`, immutable sender/delivery fields, `status: sent`, and a sender identity consistent with the `senderType`/`isDriver` pair. Canonical ordering never trusts the device clock.

Text messages require non-empty text. Image messages may have an empty caption but require bounded image and thumbnail URLs. Reply metadata is bounded and cannot become an unbounded embedded message.

The legacy unversioned validation branch remains temporarily available so installed production clients continue working during rollout.

## Delivery lifecycle

1. The screen creates the message ID before sending.
2. Direct delivery and any queued replay use that same ID.
3. A transaction creates the record only when absent.
4. An existing record is accepted only when its idempotency key and sender identities match.
5. Manual retry preserves the failed message ID and reply context.
6. When connectivity is explicitly offline, text sends queue without resolving or touching Firebase first.
7. Chat photo sends always enter the identity-scoped `PHOTO_UPLOAD` queue. The action contains a bounded dependent chat-message record, so upload and message creation replay as one idempotent delivery using the same photo-upload key and chat message ID.
8. Screen-specific replay contexts skip queue types for which they did not inject a handler. Skipped actions remain unchanged; they do not consume attempts, enter backoff, or become failed.

## Read and recovery behaviour

Read receipts use Firebase server timestamps. The device keeps a separate session-start unread boundary so the divider remains stable while live read progress advances only when the reader is at the latest message. Outgoing messages never create an unread divider or unread jump target.

A transient live-listener failure must not replace a successful conversation snapshot with an empty array. The screen retains the last known messages, displays a live-update warning, and offers an explicit retry.

## Notifications

Group notifications are sent to the union of tour participant auth UIDs and coherently assigned driver auth UIDs, with the sender excluded. Both passenger and driver senders must resolve to the active tour before fanout.

Captionless image messages use `Shared a photo` rather than being rejected or producing an empty notification. Internal driver-chat creates notify the other assigned drivers and route to `Chat` with `internalDriverChat: true` and the exact `messageId`.

Users retain the `preferences.ops.group_chat` opt-out. Invalid Expo tokens are cleaned up before the Function exits.

## Verification

- `npm run test:mobile:services:chat`
- `npm run test:functions:scripts`
- `npm run test:emulators`
- `npm test`
- Expo export plus rendered browser smoke testing
