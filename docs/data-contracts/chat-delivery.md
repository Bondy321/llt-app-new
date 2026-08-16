# Chat Delivery Contract

This contract covers group chat, internal driver chat, offline replay, photo messages, and push delivery.

## Canonical paths

- Group: `chats/{tourId}/messages/{messageId}`
- Driver team: `internal_chats/{tourId}/messages/{messageId}`

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
6. Photo retries preserve both the photo-upload idempotency key and chat message ID.

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
