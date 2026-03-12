# Scratchpad (agent notes)

I focused on **offline queue replay resilience** in `services/offlineSyncService.js`.

## Why this mattered most
- This app is explicitly optimizing for flaky connectivity and offline-first operation.
- A single unexpected throw from one replay action could previously abort the full replay run and leave remaining queued actions unsynced.
- For TestFlight readiness, graceful degradation is more valuable than perfection in one action; queue execution should continue even if one handler misbehaves.

## What I changed
- Wrapped `applyReplayAction(...)` inside `replayQueue(...)` with a local `try/catch`.
- If a replay handler throws, we now:
  - log a structured error with `actionId` and `actionType`
  - convert it to a normalized failure (`RESPONSE.fail(error)`)
  - continue normal retry/backoff handling for that action
  - continue processing remaining queued actions

## Outcome
- Replay loop is now fault-tolerant against thrown exceptions from service handlers.
- Existing retry semantics, lock semantics, and queue stats behavior are preserved.

## Personal note
This felt like the highest leverage reliability fix: users don't care *why* sync got interrupted; they only feel that it stopped. Now one bad action no longer blocks the whole queue.
