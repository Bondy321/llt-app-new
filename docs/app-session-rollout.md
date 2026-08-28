# App Session and Live-State Security Rollout

This rollout is ordered. Do not deploy strict RTDB rules before the Functions,
explicit stable-OFF policy, and read-only preflight are verified. Do not let a
source write or projector trigger select the live-state phase.

Run the repository tests, emulator tests, web-admin build, Expo environment
validation, release security audit, and `git diff --check` from the exact release
commit. Confirm the Firebase project is `loch-lomond-travel` and retain a current
RTDB export outside the repository without credentials, sessions, or raw backup
data in Git.

## Required order

### 1. Deploy Functions

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT='60'
firebase deploy --only functions --project loch-lomond-travel
```

Verify the new HTTPS, trigger, and scheduled Functions in `europe-west1`, including
`updateDriverLocationPickup`, `getLiveStateRollout`, and `setLiveStateRollout`.

### 2. Dry-run, then materialise explicit stable OFF generation zero

The materialiser never replaces a present malformed, transitioning, enabled, or
non-zero-generation policy.

```powershell
npm --prefix functions run materialize:driver-policy -- --project=loch-lomond-travel
npm --prefix functions run materialize:driver-policy -- --project=loch-lomond-travel --apply --confirm-project=loch-lomond-travel
```

The exact safe state is schema 1, `enforceSingleDevice: false`, `generation: 0`,
`revision >= 1`, a positive `updatedAtMs`, and `transitionPhase: stable` with no
active transition fields.

### 3. Run the read-only strict-rules preflight

```powershell
npm --prefix functions run preflight:strict-rules -- --project=loch-lomond-travel
```

Stop on any failure. Missing state is not acceptable at this boundary.

### 4. Deploy strict Realtime Database and Storage rules

```powershell
firebase deploy --only database,storage --project loch-lomond-travel
```

Verify direct client access to private pickup, rollout, operation, policy, and
projection-state roots is denied while compatibility-phase 1.0.4 shared live-state
writes still behave as tested.

### 5. Deploy web admin

```powershell
npm run deploy:web-admin -- --project loch-lomond-travel
```

Verify an operations admin can use the server-owned assignment and policy flows,
and that a non-admin cannot call them or read private state.

### 6. Release the 1.0.5 native binary

Runtime 1.0.5 requires its matching native binary. Build and distribute that
binary before publishing any 1.0.5 OTA. Verify passenger and driver login,
multi-device live sharing, trusted pickup publication/withdrawal, assignment,
logout, revoke, offline pending logout, and photo/media boundaries on devices.

### 7. Observe mixed-version operation

Keep `live_state_rollout/v1` missing or explicitly `compatibility`. Observe 1.0.4
and 1.0.5 traffic, projection retries, RTDB denials, session cleanup, assignment
completion, pickup retention, and support reports. A source write does not advance
the phase. Do not treat a successful Function/rules deploy as device uptake.

### 8. Keep live state in compatibility

Cutover is not operationally available in this release. A request to set
`phase: cutover` fails with `LIVE_STATE_CUTOVER_PREREQUISITE_NOT_MET`, even with
valid admin authentication and the current revision. Keep the state missing or
explicitly `compatibility`.

The schema, projector, and rules retain cutover characterization for a future
reviewed release. That release must first prove either a prior 1.0.4 OTA that maps
permission denial to an explicit update-required experience, or a verified
zero-supported-legacy-client gate. An untouched 1.0.4 binary writes RTDB directly,
so this release cannot honestly provide it a literal `UPDATE_REQUIRED` response.

## Existing app-session migration

If legacy session data still needs removal, run `migrate:app-sessions` dry-run
pages first and apply only bounded pages using `FORCE_SECURE_RELOGIN`, exact
cursors, an explicit project confirmation, and protected external backups. Never
synthesise trusted sessions from participant rows, grants, assignments, or tokens.

## Rollback

- Prefer a forward Function fix while keeping private roots and app sessions
  authoritative.
- Remain explicitly in `compatibility`. The current endpoint cannot enable
  cutover. If a future or externally imported state is already cutover, a reviewed
  revision-checked return to `compatibility` is the safe direction and mixed-version
  behavior must be verified again.
- Never restore auth-wide, participant-only, assignment-only, or direct private
  pickup access.
- A corrected 1.0.5 OTA requires the matching 1.0.5 binary already installed;
  otherwise distribute a corrected binary.
