# Reactions Write Contract (Source of Truth)

This document is the single source of truth for chat reaction writes in the LLT app.

## Canonical storage path

All reaction writes must target the user-leaf path:

`chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId} = true`

`userId` is the RTDB path key for the actor. Passenger actors use the opaque server-issued
`pax_v2_{32 hex characters}` principal and pass it through `toRealtimeKeySegment()` before writing
the leaf. The principal contains no booking credentials or personal data. Driver actors may use either the current auth UID or the canonical driver principal
`driver:{DRIVER_ID}`; rules only trust that driver principal when `users/{auth.uid}/driverId`
matches and `drivers/{driverId}/authUid` is the caller. Driver-authored group chat messages use
the same proof, so reactions to newly sent driver messages target a server-backed message.

## Canonical write behavior

### Add reaction

Set the user leaf to `true`:

`set(chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId}, true)`

### Remove reaction

Remove only the user leaf node:

`remove(chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId})`

### Toggle reaction

1. Read the current emoji node.
2. Add/remove only the canonical user leaf.
3. Never overwrite `reactions/{emoji}` as part of toggle.

## Anti-patterns (forbidden)

### Full emoji map transaction/update

The following patterns are forbidden for toggles because they overwrite the whole emoji node:

- `transaction(chats/.../reactions/{emoji}, updater)`
- `set(chats/.../reactions/{emoji}, {...})`
- `update(chats/.../reactions/{emoji}, {...})` when intended as toggle logic

Reason: overwriting `reactions/{emoji}` can drop concurrent leaf writes and violates canonical write guarantees.

### Parent-path writes (explicitly forbidden)

No reaction method (`addReaction`, `removeReaction`, `toggleReaction`) may write to any of the following parent paths:

- `chats/{tourId}/messages/{messageId}`
- `chats/{tourId}/messages/{messageId}/reactions`
- `chats/{tourId}/messages/{messageId}/reactions/{emoji}`

Equivalent code-level anti-patterns include:

- `set(chats/.../messages/{messageId}, ...)`
- `update(chats/.../messages/{messageId}, ...)` for reaction mutations
- `set(chats/.../reactions/{emoji}, ...)` without `/{userId}`
- `remove(chats/.../reactions/{emoji})` without `/{userId}`

Reason: parent writes can overwrite sibling users' reaction state and violate per-user isolation.
