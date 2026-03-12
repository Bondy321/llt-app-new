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
