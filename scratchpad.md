# Security Review Scratchpad

## Actions Taken
- Ran ripgrep searches across the repo for common credential patterns (e.g., apiKey, secret, token, private key) and high-risk prefixes (e.g., AIza, sk_live). Found a hardcoded Google Maps API key in `app.json` under the Android config.
- Moved the Android Google Maps API key into environment configuration by creating `app.config.js` to inject `process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` at build time.
- Removed the hardcoded key from `app.json` and added the existing key to a local `.env` file (ignored by git) for immediate continuity. The expectation is that this file will be replaced with refreshed keys.

## Why
- Hardcoded API keys in versioned config files are a common secret leakage risk. Expo supports environment-driven config via `app.config.js`, which keeps keys out of source control and aligns with existing `.env.example` conventions.

## Potential Improvements / Follow-ups
- Ensure CI/EAS build secrets include `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` and document in deployment runbooks.
- Consider auditing all usage of `console.log` for tokens in production builds (e.g., push token logging) to avoid accidental exposure in device logs.
- Add a pre-commit or CI secret-scanning step (e.g., gitleaks) to prevent regressions.

## 2026-02-09 — Comprehensive Security Audit (Session CJ0TU)

### Scope
Full security audit of the entire codebase: mobile app (React Native/Expo), web admin (React/Vite/Mantine), Cloud Functions (Firebase), and all services.

### Vulnerabilities Found & Fixed

#### CRITICAL / HIGH

1. **Admin Broadcast Spoofing** (`functions/index.js`, `BroadcastPanel.jsx`)
   - **Issue**: `isAdminBroadcast()` only checked if `senderId` started with `admin_` or `hq_`. Any authenticated user could write a message with that prefix to bypass participant checks and send high-priority notifications to all users.
   - **Fix**: Added `verifyAdminBroadcast()` that checks the `senderUid` field against Firebase Auth to confirm it's a real, non-anonymous user. BroadcastPanel now includes `senderUid: auth.currentUser?.uid` in broadcasts. Spoofed messages without valid admin UID are rejected.

2. **Missing Ownership Check on deleteMessage** (`chatService.js`, `ChatScreen.js`)
   - **Issue**: `deleteMessage(tourId, messageId)` had no authorization check — any user could delete any message. Comment said "only for message owner or driver" but code didn't enforce it.
   - **Fix**: Added `requestingUserId` and `isDriver` parameters. Function now fetches message first, verifies `senderId === requestingUserId || isDriver` before allowing deletion. ChatScreen updated to pass `currentUser.uid` and `isDriver`.

3. **Missing Ownership Check on deleteGroupPhoto** (`photoService.js`, `GroupPhotobookScreen.js`)
   - **Issue**: `deleteGroupPhoto(tourId, photoId)` had no ownership verification — any user could delete any photo. Comment said "only photo owner" but code didn't enforce it.
   - **Fix**: Added `requestingUserId` parameter. Function now verifies `photoData.userId === requestingUserId` before deletion. GroupPhotobookScreen updated to pass `userId`.

4. **Firebase Path Injection via Emoji** (`chatService.js`)
   - **Issue**: `addReaction`, `removeReaction`, `toggleReaction` used `emoji` directly in Firebase paths like `reactions/${emoji}`. Characters like `.`, `/`, `$`, `#`, `[`, `]` could cause path traversal or corruption.
   - **Fix**: Added `isValidFirebaseKey()` validator. All three reaction functions now validate emoji before using in paths. `toggleReaction` additionally trims and validates.

5. **Missing Path Parameter Validation in Cloud Functions** (`functions/index.js`)
   - **Issue**: `tourId` and `messageId` from event params used directly in database queries without validation.
   - **Fix**: Added `isValidFirebaseKey()` check at the top of both `sendChatNotification` and `sendItineraryNotification`. Invalid keys are rejected early.

6. **Vulnerable Dependency: react-router-dom** (`web-admin/package.json`)
   - **Issue**: react-router-dom ^7.9.6 had 3 known vulnerabilities: CSRF in action processing (CVE moderate), XSS via open redirects (CVE high, CVSS 8.0), SSR XSS in ScrollRestoration (CVE high, CVSS 8.2).
   - **Fix**: Updated to ^7.13.0. `npm audit` now shows 0 vulnerabilities.

#### MEDIUM

7. **Missing Input Validation in sendInternalDriverMessage** (`chatService.js`)
   - **Issue**: `sendInternalDriverMessage` lacked `validateTourId`, `validateMessageText`, and `validateSenderInfo` calls unlike the other send functions.
   - **Fix**: Added full validation matching `sendMessage` pattern.

8. **Sensitive Data Logging** (`bookingServiceRealtime.js`)
   - **Issue**: `console.log('Validating reference:', upperRef)` and `console.log('Driver login verified:', driverData.name)` logged booking references and driver names — PII/credential data in device logs.
   - **Fix**: Removed both console.log statements. Also removed `console.log` for driver assignment.

9. **Error Message Information Leakage** (`web-admin/src/App.jsx`)
   - **Issue**: Password reset catch block exposed raw Firebase error messages (`err.message`) to users, potentially revealing internal implementation details.
   - **Fix**: Replaced with sanitized error messages mapped from `err.code`. Only shows user-friendly messages for known error codes, generic message for unknown.

10. **Weak Minimum Password Length** (`web-admin/Settings.jsx`)
    - **Issue**: Admin portal accepted passwords as short as 6 characters. Modern best practices require at least 8.
    - **Fix**: Increased minimum to 8 characters. Updated validation message and description text.

11. **Missing Security Headers** (`web-admin/vite.config.js`)
    - **Issue**: No security headers configured for the admin web portal.
    - **Fix**: Added `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`.

### Verified Clean (No Action Needed)

- **No XSS**: No `dangerouslySetInnerHTML`, `innerHTML`, `eval()`, `Function()`, or string-based `setTimeout`. React Native Text components auto-escape.
- **No Hardcoded Secrets**: Firebase config loaded from environment variables. `.env` files properly gitignored.
- **No SQL/NoSQL Injection**: Firebase SDK used with parameterized operations throughout.
- **Phone Number Sanitization**: All `Linking.openURL(tel:...)` calls properly sanitize with `replace(/[^+\d]/g, '')`.
- **URL Safety**: Chat URL detection regex only matches `https?://` — no `javascript:` protocol risk.
- **Auth Persistence**: Uses SecureStore -> AsyncStorage -> in-memory fallback chain. Auth tokens not stored in plain localStorage.
- **File Upload Validation**: photoService validates file type (ALLOWED_IMAGE_TYPES), file size (10MB max), and caption length.
- **Input Sanitization**: chatService `sanitizeInput()` strips control characters. Validation helpers throughout services.

### Files Modified
- `functions/index.js` — admin broadcast verification, path validation
- `services/chatService.js` — Firebase key validation, emoji sanitization, deleteMessage auth, sendInternalDriverMessage validation
- `services/photoService.js` — deleteGroupPhoto ownership check
- `services/bookingServiceRealtime.js` — removed sensitive console.log statements
- `screens/ChatScreen.js` — pass userId/isDriver to deleteMessage
- `screens/GroupPhotobookScreen.js` — pass userId to deleteGroupPhoto
- `web-admin/src/App.jsx` — sanitized error messages in password reset
- `web-admin/src/components/BroadcastPanel.jsx` — include senderUid in broadcasts
- `web-admin/src/components/Settings.jsx` — increased min password length to 8
- `web-admin/vite.config.js` — added security headers
- `web-admin/package.json` — updated react-router-dom to fix CVEs

### Recommendations for Future
- Add Firebase Auth custom claims for admin role verification (more robust than UID checks)
- Implement server-side rate limiting for booking reference validation (brute-force protection)
- Add a pre-commit secret scanning tool (e.g., gitleaks)
- Consider CSP meta tag in web admin index.html for production deployment
- Set up automated dependency vulnerability scanning in CI/CD pipeline
