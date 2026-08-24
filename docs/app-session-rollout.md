# App Session Security Rollout

## Release principle

This is a forced-secure-relogin cutover. Never infer a trusted session from a legacy participant row, access grant, driver assignment, or push token. Do not deploy strict rules until the compatible Functions and TestFlight OTA are available.

No native dependency or Expo config change is part of this rollout, so publish the mobile change through `.github/workflows/eas-update.yml`; do not create a new iOS binary.

## Preflight

From the exact release commit on `main`:

```powershell
npm test
npm run test:emulators
npm run build:web-admin
npm run validate:expo-env
npm run security:audit:release
git diff --check
```

Confirm Firebase CLI and GitHub CLI target `loch-lomond-travel`, ensure a current RTDB backup/export exists outside the repository, and announce a short login maintenance window. Do not put raw database backup data, credentials, session IDs, or push tokens in Git.

## Safe staged order

### 1. Deploy compatible backend

Deploy Functions first. This adds session-aware login, logout/revocation, cleanup, and private/group media endpoints while the old mobile binary can still launch:

```powershell
$env:FUNCTIONS_DISCOVERY_TIMEOUT='60'
firebase deploy --only functions --project loch-lomond-travel
```

Verify the new HTTPS and scheduled Functions exist in `europe-west1`, and run authenticated smoke checks for passenger login, driver login, and admin session visibility. Do not expose request tokens in logs.

### 2. Publish the compatible TestFlight OTA

Push the verified commit to `main`. The `EAS Update — TestFlight` workflow publishes iOS JavaScript to the isolated `testflight` channel. Manually dispatch only if the push trigger did not run:

```powershell
gh workflow run eas-update.yml --ref main
gh run list --workflow eas-update.yml --limit 5
```

Wait for a successful workflow and confirm a TestFlight device receives the update. Exercise fresh passenger and driver logins, server-mediated group/private media, normal logout, offline logout-pending/retry, and a remote admin revoke. This stage does not rebuild iOS.

### 3. Inventory and force secure re-login

Dry-run pages first. Keep every returned continuation cursor and repeat until all three are null:

```powershell
npm --prefix functions run migrate:app-sessions -- --project=loch-lomond-travel --limit=25
```

Review counts for invalid participants, grants, push tokens, multi-tour UIDs, inferred-only sessions, and truncated parents. Any `truncatedParents` entry must be investigated; apply refuses it.

During the maintenance window, apply one bounded page at a time with the page's exact cursors and a new protected backup filename:

```powershell
npm --prefix functions run migrate:app-sessions -- --project=loch-lomond-travel --apply --confirm-project=loch-lomond-travel --cutover=FORCE_SECURE_RELOGIN --backup=C:\secure-backups\app-session-page-001.json --limit=25
```

The script writes only leaf-level/multipath removals, deactivates existing push tokens, does not create sessions, and verifies every changed path. Require `postRunAudit.passed=true` for each page. Never commit the backup.

### 4. Deploy strict data and media rules

Immediately after the bounded cutover succeeds, enforce app sessions and deny direct private/group Storage access:

```powershell
firebase deploy --only database,storage --project loch-lomond-travel
```

Legacy clients and locally cached legacy sessions must now fail closed and perform secure online login. A stale participant, stale assignment, old Auth token, or stable private owner claim cannot restore access.

### 5. Deploy operations UI

Deploy the session inspection/revocation controls:

```powershell
npm run deploy:web-admin -- --project loch-lomond-travel
```

Confirm an operations admin can see masked session state and revoke a current session, and that a non-admin cannot call the endpoint or read protected admin data.

## Post-cutover verification

- Old participant/grant rows from every migration page are gone.
- A passenger with a fresh verified login has one matching session and schema-v2 participant row.
- A logged-out passenger's still-valid Firebase token receives permission denied on tour, chat, manifest, notification, report, log, and photo metadata paths.
- A logged-out assigned driver cannot read or write operational tour paths and receives no operational push.
- Direct Storage access to both photo roots fails for signed-in and signed-out callers.
- Function media resolution succeeds only for a current member/assigned driver and returns expiring URLs with private/no-store response policy.
- Normal logout preserves opaque passenger identity and `authorizedAuthUid`; same-installation re-login works, another UID still gets `REAUTHORIZE_REQUIRED`.
- `app_session_events` contains only bounded safe audit data and cleanup removes expired events.
- Monitor Cloud Functions errors, RTDB permission denials, logout-pending support reports, active-session counts, push-recipient counts, media authorization failures, and driver access.

## Rollback

Prefer forward fixes. Restoring auth-wide or participant-only access is not an acceptable rollback.

- Functions: retain the new endpoints. Roll forward a backend bug while sessions remain authoritative.
- Mobile: publish a corrected OTA to `testflight`; do not move users back to a client that directly addresses Storage.
- Migration: the protected page backups are evidence/recovery inputs, but do not blindly restore participant rows, access grants, or active push tokens. Validate each proposed leaf against a newly verified app session.
- Rules: if a false denial blocks service, deploy a narrowly scoped, time-bounded rule correction that still requires an active app session. Never restore `auth != null`, stable-claim-only private media, or assignment-only driver authority.
- If secure operation cannot be restored quickly, keep the app in forced online re-login/maintenance mode and preserve the denial boundary.
