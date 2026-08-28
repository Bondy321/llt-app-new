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

The API can report a missing record as the compatibility default
`enforceSingleDevice: false`, generation/revision zero. Before acquiring a login
admission, `verifyDriverLogin` transactionally materialises an explicit
generation-zero OFF record with revision one. Driver-only writes require that
valid materialised policy and exact generation; the missing default cannot grant
write authority. A malformed record fails closed, and clients cannot read,
create, change, or delete the policy.

## Authority

Every driver request still requires a current server-issued app session, matching Auth UID, driver principal and user profile, current tour assignment, and an unexpired session. Turning the policy off removes only the legacy scalar-claim requirement; it does not weaken any session or tour check.

Driver sessions carry server-only `driverLoginPolicyGeneration`. Rules and
Functions require it to equal the current materialised policy generation.

When enforcement is off, operational notifications fan out to every active, current-generation session for the assigned driver. When it is on, the same selection additionally requires `drivers/{driverId}/authUid` to equal that installation UID.

## Changes

The web-admin Settings screen calls `getDriverLoginPolicy` and `setDriverLoginPolicy`. Both endpoints require an authenticated operations admin and use optimistic `expectedRevision` comparison.

Normal logins do not use a repository-wide mutex. A short admission is created in
the policy transaction. With enforcement off, unrelated drivers and two UIDs for
the same driver may proceed concurrently. With enforcement on, a per-driver
`driver_login_claim_reservations/{driverId}` transaction serialises the claim.

Turning enforcement on:

1. transactionally changes the policy phase from `stable` to `draining`, which
   rejects new admissions with `DRIVER_POLICY_CHANGE_IN_PROGRESS`;
2. waits for admitted logins to finish or for their bounded admission to expire,
   while durable assignment admissions remain until explicit transition release;
3. transactionally commits the generation barrier and enforcement flag;
4. pages all app sessions and queues every exact old-generation session under
   `driver_login_policy_cleanup/v1/{authUid}`;
5. pages drivers and clears old scalar claims;
6. writes credential-free audit events under `driver_login_policy_events`;
7. returns to `stable`, after which the first verified handset per driver can claim it.

The transition cursor and counts live durably in `driver_login_policy/v1`; the
scheduled worker resumes 100 records per page. Correctness does not depend on the
old 60-second policy lock surviving the 120-second Function. More than 500
sessions are handled by continuation rather than rejected.

A login keeps its admission through server-owned session issuance. A policy-root
completion transaction verifies the admitted generation and phase, then removes
that exact admission; this is the login/policy linearization point. A drain may
start concurrently, but its generation barrier cannot overtake the admitted
login, and the endpoint does not return a failure after committing a new driver
session.

Cleanup disables all delivery for the old installation and removes its session-derived presence, read, typing, live-tracking and location state. Exact session IDs prevent a delayed cleanup job from ending a newer login. A scheduled worker retries lock-contended cleanup every 15 minutes, removes expired cleanup jobs after seven days, and removes expired audit events after one year.

Turning enforcement off is one non-destructive policy transaction. It does not
increment the generation or invalidate valid current sessions. Further verified
handsets can log in immediately.

All policy, admission, claim-reservation, cleanup, transition, and audit state
denies direct client reads and writes.

## Release order

This is a coordinated cutover: deploy the compatible Functions and strict policy
rules in the approved backend window, verify the materialised policy, then deploy
web admin and release the 1.0.5 mobile binary. Old driver-write clients do not
satisfy the final session/policy requirements. This repository change performs no
deployment.
