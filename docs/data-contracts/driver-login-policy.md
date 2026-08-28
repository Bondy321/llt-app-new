# Driver Login Device Policy

## Purpose

`driver_login_policy/v1` controls whether one driver code may have one current handset or several. The policy is server-owned, client-unreadable, and defaults to multiple handsets when the record does not yet exist.

```json
{
  "schemaVersion": 1,
  "enforceSingleDevice": false,
  "generation": 0,
  "revision": 1,
  "updatedAtMs": 123,
  "updatedByHash": "24-character actor hash"
}
```

The missing record is reported as `enforceSingleDevice: false`, `generation: 0`, and `revision: 0`. RTDB Rules apply the same compatibility default and accept only generation-zero driver sessions while the record is absent. Before issuing the first new driver session, `verifyDriverLogin` transactionally materialises an explicit generation-zero OFF record. A present malformed record fails closed, and clients cannot read, create, change, or delete the policy.

## Authority

Every driver request still requires a current server-issued app session, matching Auth UID, driver principal and user profile, current tour assignment, and an unexpired session. Turning the policy off removes only the legacy scalar-claim requirement; it does not weaken any session or tour check.

Driver sessions carry server-only `driverLoginPolicyGeneration`. Existing generation-less sessions are treated as generation zero only while no policy record exists. Rules and Functions require the session generation to equal the current policy generation.

When enforcement is off, operational notifications fan out to every active, current-generation session for the assigned driver. When it is on, the same selection additionally requires `drivers/{driverId}/authUid` to equal that installation UID.

## Changes

The web-admin Settings screen calls `getDriverLoginPolicy` and `setDriverLoginPolicy`. Both endpoints require an authenticated operations admin and use optimistic `expectedRevision` comparison.

Turning enforcement on:

1. serialises against driver login through `driver_login_policy_locks/v1`;
2. increments `generation`, immediately invalidating every older driver session;
3. clears all legacy scalar driver claims so no old handset is chosen silently;
4. queues exact-session cleanup under `driver_login_policy_cleanup/v1/{authUid}`;
5. writes a credential-free audit event under `driver_login_policy_events`;
6. allows the first subsequently verified handset for each driver code to claim that driver.

Cleanup disables all delivery for the old installation and removes its session-derived presence, read, typing, live-tracking and location state. Exact session IDs prevent a delayed cleanup job from ending a newer login. A scheduled worker retries lock-contended cleanup every 15 minutes, removes expired cleanup jobs after seven days, and removes expired audit events after one year.

Turning enforcement off does not sign drivers out and does not increment the generation. Further verified handsets can log in immediately.

All policy, lock, cleanup, and audit roots deny direct client reads and writes.

## Release order

Deploy this change in stages: Realtime Database Rules first, Functions second, and web-admin Hosting last. The new Rules remain compatible with the old single-device Function, while the new multi-handset Function requires the policy-aware Rules. Do not deploy the Function before the Rules are confirmed active.
