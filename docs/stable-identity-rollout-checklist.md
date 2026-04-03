# Stable Identity Rollout Checklist

Use this checklist to validate stable identity ownership behavior across restarts, re-auth, and multi-device usage.

## 1) Same device restart ownership persistence

**Goal:** Message ownership remains stable after app restart on the same device.

### Steps
1. Log in as a passenger and open a tour chat.
2. Send at least one new message.
3. Confirm the message writes `senderStableId`.
4. Force-close the app and relaunch it.
5. Reopen the same tour chat.
6. Verify the previously sent message still renders as owned by the same user.

### Firebase paths to inspect
- `users/{uid}`
- `chats/{tourId}/messages/{messageId}/senderStableId`

### Pass criteria
- `users/{uid}` has a non-empty stable identity binding.
- Sent messages include `senderStableId`.
- Ownership rendering is unchanged after restart.

### Fail criteria
- `senderStableId` is missing for new messages.
- Ownership flips after restart.
- `users/{uid}` binding is absent or inconsistent.

---

## 2) Logout/login same account ownership persistence

**Goal:** Stable ownership remains correct after logging out and back in with the same account.

### Steps
1. Log in as a passenger and send a chat message.
2. Log out.
3. Log back in with the same booking/account.
4. Send another message in the same tour.
5. Compare ownership and stable IDs of old vs new messages.

### Firebase paths to inspect
- `users/{uid}`
- `chats/{tourId}/messages/{messageId}/senderStableId`

### Pass criteria
- Stable identity binding persists on `users/{uid}`.
- Both pre-logout and post-login messages resolve to the same ownership identity.
- New messages continue writing `senderStableId`.

### Fail criteria
- A new/different stable identity is unexpectedly generated.
- Message ownership diverges between sessions for the same account.
- UID-only fallback is used when stable identity should exist.

---

## 3) Second device same account behavior

**Goal:** Same account on a second device maps to the same stable sender ownership semantics.

### Steps
1. On device A, log in and send a chat message.
2. On device B, log in with the same booking/account.
3. On device B, send another message in the same tour.
4. Verify both devices render ownership consistently for that account.

### Firebase paths to inspect
- `users/{uid}`
- `chats/{tourId}/messages/{messageId}/senderStableId`

### Pass criteria
- Messages from both devices include the expected stable identity field.
- Ownership is consistent on both devices for the same account.
- No cross-device ownership drift.

### Fail criteria
- Device B writes messages without `senderStableId` when stable identity exists.
- Devices disagree on ownership for same-account messages.
- Conflicting identity state appears in `users/{uid}`.

---

## 4) Private photo access after restart

**Goal:** Private photos remain accessible after restart using booking-based ownership path.

### Steps
1. Log in as a passenger and open private photobook.
2. Upload at least one private photo.
3. Force-close and relaunch the app.
4. Reopen private photobook.
5. Confirm previously uploaded private photos still load.

### Firebase paths to inspect
- `users/{uid}`
- `private_tour_photos/{tourId}/{bookingRef}`

### Pass criteria
- Photo records remain under `private_tour_photos/{tourId}/{bookingRef}`.
- Same user can still view photos after restart.
- `users/{uid}` remains bound to expected booking ownership metadata.

### Fail criteria
- Photos become inaccessible after restart.
- New session points to wrong bookingRef bucket.
- Ownership metadata in `users/{uid}` no longer matches expected booking.

---

## 5) Driver flow non-regression

**Goal:** Driver chat and related behavior are unaffected by passenger stable identity rollout.

### Steps
1. Log in as a driver.
2. Send group chat and internal chat messages.
3. Restart app and repeat messaging checks.
4. Verify driver ownership rendering and chat actions remain unchanged.

### Firebase paths to inspect
- `users/{uid}`
- `chats/{tourId}/messages/{messageId}/senderStableId`

### Pass criteria
- Driver chat functionality works before and after restart.
- No passenger-only stable identity assumptions break driver messaging.
- No regressions in internal or group chat sending.

### Fail criteria
- Driver chat send/retry fails after rollout changes.
- Driver ownership rendering regresses.
- Any new dependency on passenger stable identity breaks driver paths.
