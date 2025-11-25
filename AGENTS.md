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

## 4. 🚨 CURRENT CRITICAL ISSUES (READ FIRST)
**Issue:** App Crash on Launch (Anonymous Auth).
**Error:** `[TypeError: Cannot read property 'setItem' of undefined]`
**Root Cause:** `AsyncStorage` native module is missing or failing to load in the standard Expo Go client (SDK 54), causing `firebase.js` and `loggerService.js` to crash when attempting to persist data.

### **Current Fix Strategy (In Progress)**
We are applying a **"Mock Block" Strategy** to bypass storage temporarily so we can resume UI development.
1.  **Action:** In `firebase.js` and `loggerService.js`, we are replacing the real `AsyncStorage` import with a dummy object:
    ```javascript
    const AsyncStorage = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
      multiRemove: async () => {},
      clear: async () => {},
    };
    ```
2.  **Goal:** Allow the app to launch and user to sign in (without "Remember Me" functionality) to unblock development.
3.  **Long Term Plan:** Migrate to `expo-secure-store` for production persistence.

## 5. Core Features

### A. Dashboard (`TourHomeScreen`)
* **Dynamic Data:** Displays Passenger names, Seat numbers, Pickup time/location.
* **Driver Info:** Shows Driver name.

### B. Communication (`ChatScreen`)
* **Scope:** Tour-specific group chat.
* **Tech:** Firebase Realtime Database (`chats/{tourId}/messages`).
* **Logic:** Messages tagged with `senderName` and `isDriver`.

### C. Photo Sharing
1.  **Private Album (`PhotobookScreen`):** User-private storage (`private_tour_photos/{tourId}/{userId}/`).
2.  **Group Album (`GroupPhotobookScreen`):** Shared bus storage (`group_tour_photos/{tourId}/`).

### D. Itinerary (`ItineraryScreen`)
* **Logic:** Fetches itinerary from Firebase. Falls back to `MOCK_ITINERARY` if data is missing.

### E. Live Map (`MapScreen`)
* **Status:** **PLACEHOLDER / MOCK UI**.
* **Current State:** Displays static dummy text. No real geolocation logic is currently active.

## 6. Key Files Map
* `App.js`: Entry point. Handles Session restoration (currently crashing due to storage) and Navigation.
* `firebase.js`: **CRITICAL**. Handles Auth config and Persistence. **Currently needs the Mock Block fix applied.**
* `services/loggerService.js`: Custom logger. **Needs `Platform` import added and Storage mocked.**
* `services/bookingServiceRealtime.js`: Validates booking refs against Realtime DB.
* `services/chatService.js`: Chat subscription logic.

## 7. Development Notes
* **Expo Go:** Must use `npx expo start --tunnel` in Codespaces.
* **Git:** `.gitignore` has been reset. `node_modules` should no longer be tracked.
* **Ports:** `19000` is forwarded, but Tunneling is preferred for stability.