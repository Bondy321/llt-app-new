# Loch Lomond Travel (LLT) App

Production-oriented monorepo for the LLT mobile passenger/driver app, web operations dashboard, and Firebase Cloud Functions.

## Workspace layout

- `App.js`, `screens/`, `components/`, `services/`: Expo React Native app (passenger + driver).
- `web-admin/`: React + Vite operations dashboard.
- `functions/`: Firebase Cloud Functions Gen 2 notification backend.
- `docs/`: cross-platform contracts and operational runbooks.

## Current architecture (high level)

```text
Google Sheets CMS
   -> Apps Script sync
      -> Firebase Realtime Database (source of truth)
         -> Mobile app (passengers + drivers)
         -> Web admin dashboard
         -> Cloud Functions (Expo push notifications)
```

## Core engineering contracts

1. **Firebase region:** all functions and backend resources run in `europe-west1`.
   - For storage-triggered photo variants, set Functions param `PHOTO_VARIANTS_BUCKET` to a bucket that is also in `europe-west1`.
2. **Date parsing:** only strict UK (`dd/MM/yyyy`) or ISO (`yyyy-MM-dd`) date strings are accepted.
3. **Driver assignment writes:** must be multi-path and keep `drivers`, `tours`, and `tour_manifests` synchronized.
4. **Sync UX contract:** use canonical sync states (`OFFLINE_NO_NETWORK`, `ONLINE_BACKEND_DEGRADED`, `ONLINE_BACKLOG_PENDING`, `ONLINE_HEALTHY`).
5. **Logging safety:** avoid raw credential/session identifiers and use `loggerService` redaction helpers.

See docs:
- `docs/date-contract.md`
- `docs/date-contract-web-admin.md`
- `docs/data-contracts/driver-assignment.md`
- `docs/offline-tour-pack.md`
- `docs/safe-logging-conventions.md`

## Local development

### Mobile app (Expo)

```bash
npm install
npm start
```

Useful variants:

```bash
npm run start:dev
npm run ios
npm run android
```

### Web admin

```bash
cd web-admin
npm install
npm run dev
```

### Functions

```bash
cd functions
npm install
npm run serve
```

## Test commands

```bash
npm test
npm run test:mobile
npm run test:web-admin
npm run test:all:with-emulators
```

Sectioned suites:

```bash
npm run test:mobile:auth
npm run test:mobile:sync:contract
npm run test:mobile:sync:engine
npm run test:mobile:services:booking
npm run test:mobile:services:chat
npm run test:mobile:services:photo
npm run test:mobile:services:notifications
npm run test:mobile:ui:date-time
npm run test:mobile:ux
npm run test:mobile:infra
```

Emulator-only suite (run only when needed):

```bash
npm run test:emulators
```

## Build + release

### EAS builds

```bash
npm run build:dev:ios
npm run build:dev:android
npm run build:dev:ios-device
npm run build:preview
npm run build:production
```

### OTA updates

```bash
npm run update:dev
npm run update:prod
```

> `runtimeVersion` uses Expo `appVersion` policy, so runtime-incompatible native changes still require shipping a new binary build.
