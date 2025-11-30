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
    * `/users/{userId}`: **[NEW]** Stores Expo Push Tokens and user notification preferences.

**Firebase Storage:**
* Stores the actual image files for the photobook features, mirroring the database structure.

**React Native App:**
* **Login:** Booking Reference (e.g., T12345).
* **Home:** Digital boarding pass, tour details, "Today's Agenda" widget.
* **Features:** Itinerary view, Group Chat, Photo Sharing (Public/Private), Driver Location, Notification Settings.

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

### C. Push Notification Infrastructure (Nov 2025)
We have implemented the foundation for Push Notifications using `expo-notifications`.
* **Preferences:** Users can now toggle specific alert types (Driver Updates, Itinerary Changes, Marketing interests) in `NotificationPreferencesScreen`.
* **Token Storage:** Upon saving preferences, the device's Expo Push Token is generated and stored in `/users/{userId}`.
* **Testing:** A "Test Notification" button has been added to the preferences screen to verify device permissions and local alert display without a backend trigger.

---

## 3. Firebase Security Rules (Reference)

The Realtime Database rules are strictly configured to enforce data isolation and secure the new features. **Do not modify paths in the frontend code without ensuring they match these rules.**

{
  "rules": {
    // 1. BOOKINGS
    // The app reads booking details to log you in.
    "bookings": {
      "$bookingId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 2. TOURS
    // The app reads tour details and updates participant counts/lists when you join.
    "tours": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 3. CHAT
    // Allows reading and posting messages to the tour chat.
    "chats": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 4. LOGS
    // The app sends debug logs to /logs/{userId}/...
    "logs": {
      "$userId": {
        ".read": false, 
        ".write": "auth != null || $userId === 'anonymous'" 
      }
    },

    // 5. PUBLIC/GROUP PHOTOS
    // Matches the path used in your updated photoService.js
    "group_tour_photos": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 6. PRIVATE PHOTOS
    // Matches the path used in your updated photoService.js
    "private_tour_photos": {
      "$tourId": {
        "$userId": {
          ".read": "auth != null && auth.uid === $userId",
          ".write": "auth != null && auth.uid === $userId"
        }
      }
    },

    // 7. USERS (NEW - For Push Notifications)
    // Allows users to save their push token and notification preferences.
    "users": {
      "$userId": {
        // Only the user themselves can read/write their own data
        ".read": "auth != null && auth.uid === $userId",
        ".write": "auth != null && auth.uid === $userId"
      }
    }
  }
}
4. Current Codebase Status
Tech Stack: React Native (Expo SDK 52), Firebase JS SDK (Modular), Google Apps Script.

Auth: Anonymous Auth + Custom Claims logic.

Navigation: React Navigation (Stack).

Key Files
App.js: Entry point, auth loading, navigation routing.

services/photoService.js: [CRITICAL] Handles upload logic and path generation. Matches Security Rules #5 & #6.

services/notificationService.js: [NEW] Handles permission requests, token generation, and saving user preferences to /users.

services/bookingServiceRealtime.js: Data layer for fetching/parsing tour data.

screens/ItineraryScreen.js: The smart itinerary viewer.

screens/NotificationPreferencesScreen.js: UI for managing alerts and testing push notifications.

5. Known Issues & "Watch List"
Date Parsing (UK vs US)
Issue: JS Date() defaults to US format (MM/dd/yyyy), but backend data is UK (dd/MM/yyyy).

Status: Manual parsing logic (split('/').map(Number)) is implemented in ItineraryScreen and TodaysAgendaCard.

Directive: Always ensure any new date logic uses manual parsing to prevent Invalid Date crashes on Android.

Driver Map
Status: MapScreen.js is currently a placeholder.

Constraint: Feature is "No Go" until the Driver App is built to feed live coordinates.

6. Upcoming Roadmap
Backend Notification Trigger: Create the backend logic (likely Cloud Functions) to listen for database changes (e.g., new chat messages) and send push notifications to the tokens stored in /users.

Driver App/Tracking: Build the driver-side application to feed real-time coordinates to MapScreen.

Production Polish: Final UI/UX refinements before store submission.

Agent Directive
When working on this repo:

Respect the Paths: The path names group_tour_photos, private_tour_photos, and users are hardcoded in Security Rules. Changing them in code breaks the app.

UK Dates: Always parse dates manually (dd/MM/yyyy).

Itinerary Format: Assume JSON format first, but maintain the legacy string fallback in bookingServiceRealtime.js.