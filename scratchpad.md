# Scratchpad Notes (agent)

## What I chose to improve
I focused on push notification permission handling in `notificationService`.

## Why this matters before TestFlight
On iOS, users can grant **provisional** notification permission (and on newer flows, ephemeral contexts) where `status` is not strictly `"granted"`, but notifications are still allowed enough to issue Expo push tokens. The previous logic treated anything except `"granted"` as denied, which could silently disable push setup for valid users.

That is exactly the sort of thing that surfaces late in QA and feels random to ops/passengers.

## What I changed
- Added a permission helper that treats iOS provisional/ephemeral states as allowed.
- Updated registration flow to evaluate full permission objects instead of only status strings.
- Added a regression test to lock this behavior in.

## Personal thought
This is one of those tiny-but-high-leverage reliability fixes: low risk, no UI churn, but potentially removes a whole class of “why are notifications flaky for some iPhones?” issues during TestFlight.
