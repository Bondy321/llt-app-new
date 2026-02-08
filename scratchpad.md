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

## 2026-02-08 15:16:17 UTC
- Removed push token logging from client notification flows and diagnostics, plus stripped token snippets from Cloud Function logs to reduce sensitive data exposure.
- Reduced auth-related console logging of user identifiers in Firebase initialization flows to limit PII in device logs.
