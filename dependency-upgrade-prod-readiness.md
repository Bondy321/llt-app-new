# Dependency Upgrade & Production Readiness Audit

_Date run: 2026-03-13_

## Scope and method

I reviewed **all direct dependencies and devDependencies** in:
- `package.json` (mobile app)
- `functions/package.json` (Firebase Functions)
- `web-admin/package.json` (web admin)

I then cross-checked with:
- `npm outdated --json` in each workspace
- `npm audit --json` in each workspace
- code usage scans (`rg`) to estimate **upgrade impact** and whether **code changes are required**.

---

## 1) Full dependency inventory (direct deps)

## 1.1 Mobile app (`/package.json`)

### dependencies
- `@expo/vector-icons` `^14.1.0`
- `@react-native-async-storage/async-storage` `2.2.0`
- `@react-native-clipboard/clipboard` `^1.16.3`
- `@react-native-community/netinfo` `11.4.1`
- `babel-preset-expo` `~54.0.0`
- `expo` `~54.0.0`
- `expo-build-properties` `~0.14.8`
- `expo-dev-client` `~6.0.11`
- `expo-device` `~8.0.9`
- `expo-file-system` `~19.0.21`
- `expo-font` `~14.0.10`
- `expo-haptics` `^15.0.8`
- `expo-image-manipulator` `~13.1.7`
- `expo-image-picker` `~17.0.8`
- `expo-linear-gradient` `~15.0.7`
- `expo-location` `~19.0.7`
- `expo-media-library` `~18.2.1`
- `expo-notifications` `~0.32.13`
- `expo-secure-store` `~15.0.7`
- `expo-status-bar` `~3.0.8`
- `expo-updates` `~29.0.16`
- `firebase` `^9.21.0`
- `react` `19.1.0`
- `react-dom` `19.1.0`
- `react-native` `0.81.5`
- `react-native-maps` `1.20.1`
- `react-native-safe-area-context` `^5.4.1`
- `react-native-web` `^0.21.0`

### devDependencies
- `@babel/core` `^7.20.0`
- `@babel/register` `^7.28.6`
- `react-test-renderer` `^19.1.0`

## 1.2 Cloud Functions (`/functions/package.json`)

### dependencies
- `expo-server-sdk` `^4.0.0`
- `firebase-admin` `^13.6.0`
- `firebase-functions` `^7.0.0`

### devDependencies
- `firebase-functions-test` `^3.4.1`

## 1.3 Web Admin (`/web-admin/package.json`)

### dependencies
- `@mantine/core` `^8.3.9`
- `@mantine/hooks` `^8.3.9`
- `@mantine/notifications` `^8.3.12`
- `@tabler/icons-react` `^3.36.1`
- `firebase` `^12.6.0`
- `react` `^19.2.0`
- `react-dom` `^19.2.0`
- `react-router-dom` `^7.13.0`

### devDependencies
- `@eslint/js` `^9.39.1`
- `@testing-library/jest-dom` `^6.9.1`
- `@testing-library/react` `^16.3.2`
- `@types/react` `^19.2.5`
- `@types/react-dom` `^19.2.3`
- `@vitejs/plugin-react` `^5.1.1`
- `eslint` `^9.39.1`
- `eslint-plugin-react-hooks` `^7.0.1`
- `eslint-plugin-react-refresh` `^0.4.24`
- `globals` `^16.5.0`
- `jsdom` `^28.1.0`
- `vite` `^7.2.4`
- `vitest` `^4.0.18`

---

## 2) What should be upgraded before production?

## ✅ Priority 0 (must do before prod)

1. **Mobile `firebase` (`^9.21.0`)**
   - Why: `npm audit` reports moderate vulnerabilities, including Firebase SDK advisory, and transitive `@grpc/grpc-js` issues.
   - Minimum safe target: **`firebase@^10.9.0` or newer**.
   - Best target for consistency: align with web-admin at **`firebase@^12.10.0`** _only after compatibility pass_.

2. **Lockfile-level security patches for transitive vulnerabilities** (mobile/web/functions)
   - Root high severity includes `tar`; web-admin includes `rollup`, `flatted`, `minimatch`; functions includes `jws`, `minimatch`.
   - Action: run controlled `npm audit fix` per workspace and validate tests/builds.

3. **Cloud Functions dependency refresh (`firebase-functions` + `firebase-admin`)**
   - Why: there are known low/moderate/high transitive issues in functions tree.
   - Current versions are already modern, but still pull vulnerable transitive graph in lockfile.
   - Action: bump to latest patch/minor first (`firebase-admin@13.7.x`, `firebase-functions@7.1.x`) and re-audit.

## 🟡 Priority 1 (strongly recommended before prod cut)

4. **Mobile Expo SDK patch train (stay on SDK 54, patch all Expo libs)**
   - Upgrade from current to latest SDK-54-compatible patch versions first (e.g. `expo` 54.0.33, `expo-notifications` 0.32.16, etc.).
   - Keeps API mostly stable while reducing bug risk.

5. **Web-admin patch updates**
   - Move core toolchain to latest compatible patch/minor (`vite 7.3.x`, plugin-react 5.2.x, vitest 4.1.x, Mantine 8.3.16, React 19.2.4).
   - Rebuild and run tests.

## ⚪ Priority 2 (post-prod window / planned migration)

6. **Mobile major platform jump (Expo SDK 55 / RN 0.84+)**
   - This is a bigger migration and should be planned separately with QA cycle.

---

## 3) Upgrade impact assessment and required code changes

## 3.1 Mobile app

### A) `firebase` upgrade impact

**Observed usage pattern in repo:**
- Mobile app currently uses **compat APIs** in `firebase.js` (`firebase/compat/app`, auth/firestore/database compat) while mixing modular storage/database imports.
- Many services/screens depend on exported `auth`, `db`, and realtime database helpers from `firebase.js`.

**Impact if upgrading to `firebase@10.x` only:**
- Likely low impact; compat layer still available.
- **Required code changes:** likely **none** if compat imports remain unchanged.
- **Validation needed:** auth restore/login flow, Realtime DB listeners, storage upload paths.

**Impact if upgrading directly to `firebase@12.x`:**
- Higher uncertainty with compat+RN combinations.
- May require incremental migration to modular APIs (especially if compat edge behavior changes in RN).
- **Potential code change areas:** `firebase.js`, `services/photoService.js`, auth persistence flows using compat user objects.

### B) Expo patch updates (within SDK 54)

**Observed usage:**
- `expo-notifications` in `services/notificationService.js` and `screens/NotificationPreferencesScreen.js`
- `expo-location` in `screens/MapScreen.js`, `screens/DriverHomeScreen.js`, `screens/SafetySupportScreen.js`
- `expo-image-picker` in chat/photobook screens

**Impact:**
- Patch-level updates should be low risk.
- **Required code changes:** typically none; retest permission prompts and payload fields.

### C) Expo 55 / RN major jump (defer unless required)

**Impact:** medium/high.
- Possible native config and module-version alignment changes.
- Could require re-running `expo install` for all Expo-native packages and adjusting any deprecated APIs.

**Required code changes likely:**
- possible updates in notification permission handling,
- map/location behavior retesting,
- EAS build profile validation.

## 3.2 Cloud Functions

### A) `firebase-admin`, `firebase-functions`, `expo-server-sdk`

**Observed usage:**
- `functions/index.js` imports `expo-server-sdk` as CommonJS (`const { Expo } = require("expo-server-sdk")`) and uses Firebase Admin/Functions Gen2 APIs.

**Impact of patch/minor upgrades:**
- low; should be mostly lockfile + runtime verification.
- **Required code changes:** likely none.

**Impact of major `expo-server-sdk` jump (4 -> 6):**
- verify module format and constructor behavior.
- **Possible code changes:** import style or message batching options if API changed.

## 3.3 Web Admin

### A) Firebase web SDK (already v12 line)

**Observed usage:**
- Modular imports in `web-admin/src/firebase.js` and components/services using `firebase/database` + `firebase/auth` modular APIs.

**Impact of patch update to latest 12.x:**
- low.
- **Required code changes:** unlikely.

### B) Vite / plugin-react / Vitest patch-minor updates

**Impact:** low/medium.
- Build tooling behavior may tighten (ESM, test env defaults, warning behavior).
- **Required code changes:** unlikely in app code, but test setup may need tiny adjustments.

### C) React / React DOM patch update (19.2.0 -> 19.2.4)

**Impact:** low.
- **Required code changes:** none expected.

---

## 4) Concrete upgrade plan (recommended sequence)

1. **Security-first minimal blast radius**
   - Mobile: bump `firebase` to `^10.9.0` (or latest 10.x), run tests and smoke flows.
   - Functions + web-admin: patch/minor updates + `npm audit fix` where safe.

2. **SDK alignment pass**
   - Mobile: `npx expo install --fix` while staying on SDK 54.
   - Re-run mobile test suites and manual auth/chat/photo/location checks.

3. **Optional modernization pass**
   - Move mobile Firebase from compat to modular APIs gradually, then consider `firebase@12.x`.

4. **Major platform migration pass (separate ticket)**
   - Expo 55 + RN alignment with dedicated regression window.

---

## 5) Files most likely impacted when upgrades are applied

- Mobile Firebase boundary and shared services:
  - `firebase.js`
  - `services/photoService.js`
  - `services/notificationService.js`
  - `screens/NotificationPreferencesScreen.js`
  - `screens/MapScreen.js`
  - `screens/DriverHomeScreen.js`
  - `screens/SafetySupportScreen.js`
  - `screens/ChatScreen.js`
  - `screens/PhotobookScreen.js`
  - `screens/GroupPhotobookScreen.js`

- Functions notification backend:
  - `functions/index.js`

- Web admin build/runtime:
  - `web-admin/src/firebase.js`
  - `web-admin/src/main.jsx`
  - `web-admin/vite.config.js`
  - `web-admin/src/test/setupTests.js`

---

## 6) Suggested verification checklist after each upgrade batch

- Mobile:
  - login (passenger + driver), session restore, logout
  - join tour + manifest update flows
  - chat send/read + media upload
  - location permission and map rendering
  - push notification registration + preference persistence

- Functions:
  - deploy/lint/start emulator
  - verify chat and itinerary notification triggers
  - verify Expo push token validation and send path

- Web-admin:
  - dev server start/build/preview
  - authentication and tour/driver CRUD
  - notification UI and route navigation
  - vitest suite green

---

## 7) Bottom line

- **Yes, there are dependencies that should be upgraded before prod.**
- The **most important** is mobile `firebase` (security advisory coverage) and lockfile security remediation.
- Most required work is patch/minor with **low expected code churn**.
- A full Expo 55 / RN major uplift should be treated as a **separate, planned migration** rather than a last-minute pre-prod change.
