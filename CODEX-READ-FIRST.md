# Project Context: Loch Lomond Travel App

## 1. Project Overview
**App Name:** Loch Lomond Travel App
**Company:** Loch Lomond Travel (Coach tour operator based in the UK)
**Purpose:** A companion app for clients on coach tours (ranging from day trips to week-long European tours).
**Primary User:** Tour passengers.
**Authentication:** Users do not create accounts. They "log in" using a specific **Booking Reference Number** (e.g., `T114737`).

## 2. Business Logic & Architecture
The app relies on a specific data flow pipeline involving Google Sheets and Firebase.

### Data Pipeline
1.  **Source of Truth:** Google Sheets acts as the primary SQL-like database for the company.
2.  **Sync:** Data from Google Sheets is synced/pushed to **Firebase Realtime Database**.
3.  **App Consumption:** The React Native app reads directly from Firebase Realtime Database (and occasionally Firestore) to display tour details.

### Authentication Flow
* **Method:** Anonymous Authentication (`firebase.auth().signInAnonymously()`).
* **Validation:**
    1.  User enters Booking Reference on `LoginScreen`.
    2.  App checks `bookings/{ref}` in Firebase Realtime DB.
    3.  If valid, the app retrieves the associated `tourId` and signs the user in anonymously to Firebase (to handle Security Rules).
    4.  The session is persisted using `AsyncStorage`.

## 3. Tech Stack
* **Framework:** React Native (Expo SDK 53).
* **Language:** JavaScript (React).
* **Backend:** Google Firebase (v9+ Compat SDK).
    * **Realtime Database:** Primary data source for bookings, tours, and chat.
    * **Firestore:** Used for specific tour code validations (legacy/secondary).
    * **Storage:** Used for photo uploads.
    * **Auth:** Anonymous handling.
* **UI Library:** Native styles, `react-native-vector-icons` (via Expo), Linear Gradient.

## 4. Core Features & Implementation Details

### A. Dashboard (`TourHomeScreen`)
Displays dynamic data fetched based on the login reference:
* **Passenger Info:** Names, Seat numbers.
* **Logistics:** Pickup location and time.
* **Driver:** Driver's name.

### B. Communication (`ChatScreen`)
* **Scope:** Group chat exclusive to passengers (and potentially the driver) on the specific tour.
* **Backend:** Firebase Realtime Database (`chats/{tourId}/messages`).
* **Logic:** Messages are stored with `senderId` (UID) and `senderName` (from booking data).

### C. Photo Sharing
The app supports two distinct photo albums:
1.  **Private Album (`PhotobookScreen`):** Photos only the specific user can see.
    * *Storage Path:* `private_tour_photos/{tourId}/{userId}/`
2.  **Group Album (`GroupPhotobookScreen`):** Photos shared with the entire bus.
    * *Storage Path:* `group_tour_photos/{tourId}/`

### D. Itinerary (`ItineraryScreen`)
* Displays a timeline of the tour.
* **Logic:** Fetches itinerary data from Firebase. If data is missing or fails to load, it currently falls back to a hardcoded `MOCK_ITINERARY` (Loch Lomond/Highland data).

### E. Map / Driver Tracking (`MapScreen`)
* **Current Status:** **PLACEHOLDER / TEST ONLY**.
* **Intent:** To show the live location of the coach/driver.
* **Current State:** Displays a static UI with dummy text. No real geolocation logic is currently implemented.

## 5. Key Files Map
* `App.js`: Main entry point, handles Auth state, Navigation logic, and Session restoration.
* `firebase.js`: Centralized Firebase config and "AuthPersistence" logic.
* `services/bookingServiceRealtime.js`: **Critical**. Handles the logic for validating the booking ref and fetching the associated Tour Object from Realtime DB.
* `services/chatService.js`: Methods for subscribing to and sending chat messages.
* `screens/LoginScreen.js`: Handles the UI for entry and validates inputs.

## 6. Known Issues & Cleanup Notes
1.  **Map Screen:** Is purely visual right now. Do not assume it tracks real location.
2.  **Test Files:**
    * `test-firebase.js`: A standalone script for testing connections. **Safe to delete/ignore**.
    * `testFirestore.js`: A standalone script for testing Firestore. **Safe to delete/ignore**.
3.  **Data Handling:** The app must handle cases where `pickupPoints` is an array (new format) vs single `pickupLocation` fields (legacy format). This is handled in `bookingServiceRealtime.js`.
