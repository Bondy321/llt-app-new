# Project Context: Loch Lomond Travel App

## 1. Project Overview
**App Name:** Loch Lomond Travel App
**Company:** Loch Lomond Travel (Coach tour operator based in the UK)
**Purpose:** Companion app for tour passengers (day trips to week-long European tours).
**Primary User:** Tour passengers.
**Authentication:** Anonymous "Log in" via Booking Reference Number (e.g., `T114737`).

## 2. Architecture & Data Flow
1.  **Source of Truth:** Google Sheets (Business Database).
2.  **Sync Layer:** Data syncs from Sheets to **Firebase Realtime Database**.
3.  **App Layer:** React Native app reads from Firebase Realtime DB (and Firestore for some legacy validations).

## 3. Tech Stack & Environment
* **Framework:** React Native (Expo SDK 54).
* **Environment:** GitHub Codespaces (Cloud).
* **Client:** Expo Go (via `--tunnel`).
* **Backend:** Google Firebase (v9+ Compat SDK).
    * **Realtime DB:** Primary data (bookings, chats, locations).
    * **Firestore:** Secondary/Legacy (tour code validation).
    * **Storage:** Photo uploads.
    * **Auth:** Anonymous Authentication.

## 4. ✅ RESOLVED & ACTIVE WORKAROUNDS
**Status:** Stable in Expo Go.

### The "Mock Block" Strategy (Active)
To prevent native module crashes in Expo Go (specifically `AsyncStorage` and `SecureStore`), we have implemented a robust in-memory mock system.
* **Implementation:** `firebase.js` and `services/loggerService.js` use a custom `MockStorage` object.
* **Constraint:** Data **does not persist** across app reloads (hot reloads are fine, but full restarts clear the session).
* **Rule:** Do **not** import `@react-native-async-storage/async-storage` or try to use `expo-secure-store` directly without checking for the Mock fallback first.

## 5. Core Features & Development Status

### A. Dashboard (`TourHomeScreen`)
* **Status:** Working.
* **Data:** Displays dynamic passenger/booking info from Realtime DB.

### B. Communication (`ChatScreen`)
* **Status:** Working.
* **Tech:** Real-time message syncing via Firebase.

### C. Photo Sharing (CURRENT FOCUS)
1.  **Private Album (`PhotobookScreen`):** Functional but basic.
2.  **Group Album (`GroupPhotobookScreen`):** Functional but basic.
* **Goal:** Improve UX, add upload progress indicators, and ensure robust error handling.

### D. Itinerary (`ItineraryScreen`)
* **Status:** Functional. Fetches live data, falls back to `MOCK_ITINERARY` on error.

### E. Live Map (`MapScreen`)
* **Status:** **PLACEHOLDER**. Displays dummy text. No geolocation logic active.

## 6. Key Files Map
* `App.js`: Entry point. manages session state (using Mock Storage).
* `firebase.js`: **CRITICAL**. Configures Auth with `Persistence.NONE` to support the Mock Block.
* `services/firestoreService.js`: Refactored with Dependency Injection for testing.
* `services/loggerService.js`: Logging utility using in-memory storage.