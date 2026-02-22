# Safe Logging Conventions

To prevent accidental leakage of auth/session identifiers, all application logging must use the central redaction helpers in `services/loggerService.js`.

## Default behavior

- `loggerService` now sanitizes nested log payloads before:
  - console output (development mode)
  - local persistence queue
  - Firebase log upload
- Sensitive identifiers are masked by default (example: `AB***23`) rather than stored raw.
- Production builds do not emit raw logger payloads to `console`.

## Sensitive key denylist

The logger redacts values for keys including:

- `bookingRef`
- `reference`
- `driverCode`
- `token` / `pushToken`
- `authUid`
- `uid`
- `userId`
- `sessionId`
- `authorization`
- `password`

Nested objects/arrays are sanitized recursively.

## Required usage in new code

1. Prefer `logger.info|warn|error|fatal` over direct `console.log|warn|error`.
2. For explicit identifiers in callsites, pre-mask with:

```js
import logger, { maskIdentifier } from '../services/loggerService';

logger.info('Auth', 'Login success', {
  bookingRef: maskIdentifier(reference),
});
```

3. If logging complex objects, use:

```js
import { redactSensitiveData } from '../services/loggerService';
const safePayload = redactSensitiveData(payload);
```

4. Never log raw auth/session identifiers in production paths.
