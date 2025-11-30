# Loch Lomond Travel (LLT) App - Agent Onboarding & System Status

**Last Updated:** 30th November 2025

Welcome, Agent. This document provides a comprehensive overview of the current state of the LLT App ecosystem. It details the architecture, recent critical updates, known issues, and the roadmap for upcoming features.

## 1. System Architecture Overview

The LLT App is a companion application for tour passengers, built with React Native (Expo) and backed by Firebase (Realtime Database & Authentication) and Google Sheets (as the CMS).

### Core Data Flow

**Google Sheets (The CMS):**
* **Master Sheet:** `Tour Master` contains all tour definitions (codes, names, dates, durations).
* **Itinerary Sheet:** `Itineraries` contains raw text itineraries.
* **Passenger Sheet:** `Pax` contains passenger lists, pickup points, and booking references.
* **Sync Engine:** A Google Apps Script (`syncToFirebase`) parses this data and pushes it to Firebase.

**Firebase Realtime Database:**
* Acts as the middleware between the Sheet and the App.
* **Structure:**
    * `/tours/{tourId}`: Tour details, driver info, and itinerary.
    * `/bookings/{bookingRef}`: Links users to tours.
    * `/chats/{tourId}`: Group chat messages.
    * `/logs/{userId}`: User-specific app logs.
    * `/group_tour_photos/{tourId}`: Metadata for shared group photos.
    * `/private_tour_photos/{tourId}/{userId}`: Metadata for private user photos.

**Firebase Storage:**
* Stores the actual image files for the photobook features, mirroring the database structure.

**React Native App:**
* **Login:** Booking Reference (e.g., T12345).
* **Home:** Digital boarding pass, tour details, "Today's Agenda" widget.
* **Features:** Itinerary view, Group Chat, Photo Sharing (Public/Private), Driver Location.

---

## 2. Recent Critical Updates

### A. The "Itinerary 2.0" Overhaul
We transitioned from unstructured text itineraries to a smart, JSON-based system.
* **Backend:** App Script now regex-matches days and extracts specific times, pushing a JSON object.
* **Frontend:** `ItineraryScreen.js` parses this JSON to display structured timelines, distinct visual styles for major events, and collapsed/expanded views.

### B. Photo System Stabilization (Nov 2025)
We have fully stabilized the Photo Upload feature.
* **Path Alignment:** Fixed a critical mismatch between code and security rules.
    * **Group Photos:** Now stored in `group_tour_photos/{tourId}` (Storage & DB).
    * **Private Photos:** Now stored in `private_tour_photos/{tourId}/{userId}` (Storage & DB).
* **Security Rules:** Implemented strict Realtime Database rules to prevent "Permission Denied" errors while ensuring data isolation.
* **Deprecation Fixes:** Updated `Expo ImagePicker` to use the modern `mediaTypes: ['images']` syntax, resolving build warnings.

---

## 3. Current Codebase Status

* **Tech Stack:** React Native (Expo SDK 52), Firebase JS SDK (Modular), Google Apps Script.
* **Auth:** Anonymous Auth + Custom Claims logic.
* **Navigation:** React Navigation (Stack).

### Key Files
* `App.js`: Entry point, auth loading, navigation routing.
* `services/photoService.js`: **[CRITICAL]** Handles upload logic and path generation. Do not modify paths without updating Firebase Rules.
* `services/bookingServiceRealtime.js`: Data layer for fetching/parsing tour data.
* `screens/ItineraryScreen.js`: The smart itinerary viewer.
* `screens/TourHomeScreen.js`: Dashboard with the Agenda Widget.

---

## 4. Known Issues & "Watch List"

### Date Parsing (UK vs US)
* **Issue:** JS `Date()` defaults to US format (MM/dd/yyyy), but backend data is UK (dd/MM/yyyy).
* **Status:** Manual parsing logic (`split('/').map(Number)`) is implemented in `ItineraryScreen` and `TodaysAgendaCard`.
* **Directive:** Always ensure any new date logic uses manual parsing to prevent `Invalid Date` crashes on Android.

### Driver Map
* **Status:** `MapScreen.js` is currently a placeholder.
* **Constraint:** Feature is "No Go" until the Driver App is built to feed live coordinates.

### Legacy Itineraries
* **Status:** Older tours still use string-based itineraries. The app includes fallback logic to render these as simple text blocks.

---

## 5. Upcoming Roadmap

1.  **Production Polish:** Continue refining UI/UX and error boundaries.
2.  **Driver App/Tracking:** Build the driver-side application to feed real-time coordinates to `MapScreen`.
3.  **Push Notifications:** Implement logic to notify users of new chat messages or itinerary changes.

---

### Agent Directive
When working on this repo:
1.  **Respect the Paths:** The path names `group_tour_photos` and `private_tour_photos` are hardcoded in Security Rules. Changing them in code breaks uploads.
2.  **UK Dates:** Always parse dates manually (`dd/MM/yyyy`).
3.  **Itinerary Format:** Assume JSON format first, but maintain the legacy string fallback in `bookingServiceRealtime.js`.