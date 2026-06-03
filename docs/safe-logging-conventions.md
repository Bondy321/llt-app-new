# Safe Logging Conventions

All app logging must route through `services/loggerService.js` to prevent leaking identifiers, auth/session values, and PII.

## Non-negotiable rules

1. Prefer `logger.info|warn|error|fatal` over direct `console.*` in app logic.
2. Never log raw booking refs, driver codes, user IDs, auth UIDs, tokens, passwords, or session IDs.
3. Redact/sanitize nested payloads before persistence/upload.
4. Keep user-facing error messages sanitized; avoid exposing raw backend internals.

## Default logger behavior

`loggerService` redacts sensitive keys recursively before:

- development console output,
- local log queue persistence,
- Firebase log upload.

Representative protected keys include:
`bookingRef`, `reference`, `driverCode`, `token`, `pushToken`, `authUid`, `uid`, `userId`, `sessionId`, `authorization`, `password`.

## Curated operations alerts

Major mobile failures now also produce compact records under `ops_alerts/{fingerprint}` for the web-admin Operations / Health / Errors surface. Raw logs remain under `/logs` and are not scanned by the browser dashboard.

Only `ERROR` and `FATAL` logger entries and global crash diagnostics create/update ops alerts. The curated record must contain bounded, sanitised fields only: severity, level, source, component, message, status, masked user/session display keys, device info, safe tour/role context, fingerprint, count, last seen timestamps, and a short summary or crash breadcrumb summary.

Never add raw stack traces, raw auth UIDs, raw session IDs, booking references, emails, tokens, push tokens, passwords, driver codes, or authorization values to `ops_alerts`. Use `services/opsAlertService.js` helpers instead of hand-building alert records.

## Temporary verbose RTDB diagnostics

For the current smoke-test pass, `loggerService` is configured to upload `DEBUG` and `INFO` logs to `/logs/{user}/{session}` as well as warnings and errors. Keep new diagnostic call sites routed through `loggerService` or the existing crash diagnostics helpers, and keep identifiers masked/summarized. After the smoke run has exposed the underlying issues, tune the server upload floor back down or gate it behind a runtime flag before release.

## Safe call-site patterns

```js
import logger, { maskIdentifier, redactSensitiveData } from '../services/loggerService';

logger.info('Auth', 'Booking validated', {
  bookingRef: maskIdentifier(reference),
});

logger.warn('Sync', 'Replay metadata', redactSensitiveData(rawPayload));
```

## Recent hardening reminders

- Removed sensitive console logs in booking/driver validation flows.
- Password reset UX in web-admin now maps Firebase error codes to sanitized user messages.
- Security-sensitive operations should include enough context for triage, but never raw secret/credential material.
