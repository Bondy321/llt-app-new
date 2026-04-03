# Reactions Write Contract (Source of Truth)

This document is the single source of truth for chat reaction writes in the LLT app.

## Canonical storage path

All reaction writes must target the user-leaf path:

`chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId} = true`

## Legacy read compatibility (read-only)

Readers must continue to support the following historical shapes under
`chats/{tourId}/messages/{messageId}/reactions/{emoji}`:

1. Array of user IDs:
   - `["uid1", "uid2"]`
2. Object map:
   - `{ "uid1": true, "uid2": true }`

These legacy shapes are read-compatible only. New writes must always use canonical user-leaf writes.

## Canonical write behavior

### Add reaction

Set the user leaf to `true`:

`set(chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId}, true)`

### Remove reaction

Remove only the user leaf node:

`remove(chats/{tourId}/messages/{messageId}/reactions/{emoji}/{userId})`

### Toggle reaction

1. Read current emoji node (to support legacy shapes for decision-making).
2. Add/remove only the canonical user leaf.
3. Never overwrite `reactions/{emoji}` as part of toggle.

## Anti-patterns (forbidden)

### Full emoji map transaction/update

The following patterns are forbidden for toggles because they overwrite the whole emoji node:

- `transaction(chats/.../reactions/{emoji}, updater)`
- `set(chats/.../reactions/{emoji}, {...})`
- `update(chats/.../reactions/{emoji}, {...})` when intended as toggle logic

Reason: overwriting `reactions/{emoji}` can drop concurrent leaf writes and violates canonical write guarantees.
