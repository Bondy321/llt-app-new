# Loch Lomond Travel (LLT) App - Agent Onboarding & System Status

**Last Updated:** 30th November 2025

Welcome, Agent. This document provides a comprehensive overview of the current state of the LLT App ecosystem. It details the architecture, recent critical updates, known issues, and the roadmap for upcoming features.

## 1. System Architecture Overview

The LLT ecosystem has expanded to include a mobile app for passengers/drivers, a web dashboard for operations, and a serverless backend for automation.

### Core Data Flow

**Google Sheets (The CMS):**
* **Master Sheet:** `Tour Master` contains all tour definitions (codes, names, dates, durations).
* **Itinerary Sheet:** `Itineraries` contains raw text itineraries.
* **Passenger Sheet:** `Pax` contains passenger lists, pickup points, and booking references.
* **Sync Engine:** A Google Apps Script (`syncToFirebase`) parses this data and pushes it to Firebase.

**Firebase Realtime Database:**
* The central nervous system.
* **Structure:**
    * `/tours/{tourId}`: Tour details, driver info, and itinerary.
    * `/bookings/{bookingRef}`: Links users to tours.
    * `/drivers/{driverId}`: **[NEW]** Driver profiles, phone numbers, and assigned tours.
    * `/chats/{tourId}`: Group chat messages.
    * `/logs/{userId}`: User-specific app logs.
    * `/users/{userId}`: Expo Push Tokens and notification preferences.
    * `/group_tour_photos/{tourId}`: Metadata for shared group photos.
    * `/private_tour_photos/{tourId}/{userId}`: Metadata for private user photos.

**Firebase Cloud Functions (Gen 2):**
* **Triggers:** Listens for database events (new chat messages, itinerary updates) and sends Push Notifications via Expo.

**Web Admin Dashboard:**
* A React-based Operations Console (`web-admin/`) for managing drivers and sending system-wide broadcasts.

**React Native App:**
* **Single Binary Strategy:** One app for both Passengers and Drivers.
* **Passenger Mode:** Login via Booking Ref (e.g., T12345).
* **Driver Mode:** Hidden login via Driver Code (e.g., D-BONDY).
* **Features:** Itinerary, Chat, Photo Sharing, Driver Console.

---

## 2. Recent Critical Updates

### A. The "Itinerary 2.0" Overhaul
We transitioned from unstructured text itineraries to a smart, JSON-based system supported by the frontend `ItineraryScreen.js`.

### B. Notification Infrastructure (Full Pipeline)
We have a complete end-to-end notification system.
* **Frontend:** Users save preferences and push tokens to `/users/{userId}`.
* **Backend:** Cloud Functions (`sendChatNotification`, `sendItineraryNotification`) listen to DB changes and dispatch alerts via Expo.
* **Broadcasts:** Admins can trigger "Driver Announcements" via the Web Admin, which appear as high-priority alerts.

### C. The Driver Ecosystem
We implemented a "Hidden Driver Mode" to avoid managing two separate apps.
* **Login:** Inputting a code starting with `D-` (e.g., `D-BONDY`) routes the user to `DriverHomeScreen`.
* **Management:** A new Web Admin Panel allows operations staff to create drivers and assign them to multiple tours.
* **Data Sync:** Assigning a tour to a driver automatically updates the public `/tours` node so passengers see the correct Driver Name.

---

## 3. Firebase Security Rules (Reference)

**CRITICAL:** These rules enforce the separation of powers between Passengers, Drivers, and Admins.

```json
{
  "rules": {
    // Helper: Check if user is the specific Admin UID
    ".read": "auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'",
    ".write": "auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'",

    // 1. DRIVERS
    // App needs to read to verify login. ONLY Admin can write/create drivers.
    "drivers": {
      ".read": "auth != null",
      ".write": "auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'"
    },

    // 2. BOOKINGS
    "bookings": {
      "$bookingId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 3. TOURS
    "tours": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 4. CHAT
    "chats": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 5. LOGS
    "logs": {
      "$userId": {
        ".read": false, 
        ".write": "auth != null || $userId === 'anonymous'" 
      }
    },

    // 6. PHOTOS (Public/Private)
    "group_tour_photos": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "private_tour_photos": {
      "$tourId": {
        "$userId": {
          ".read": "auth != null && auth.uid === $userId",
          ".write": "auth != null && auth.uid === $userId"
        }
      }
    },

    // 7. USERS (Push Tokens)
    "users": {
      "$userId": {
        ".read": "auth != null && (auth.uid === $userId || auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23')",
        ".write": "auth != null && (auth.uid === $userId || auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23')"
      }
    }
  }
}
4. Current Codebase Status
Tech Stack: React Native (Expo SDK 52), Firebase Cloud Functions (Gen 2), React (Vite) for Admin.

Directory Structure
App.js: Main entry point, handles routing between Passenger/Driver modes.

functions/: [Backend] Cloud Functions triggers.

web-admin/: [Backend UI] The React dashboard for Ops.

services/bookingServiceRealtime.js: Handles logic for validating generic login codes (Passenger vs Driver).

screens/DriverHomeScreen.js: The dedicated dashboard for drivers.

5. Upcoming Roadmap
Live Driver Tracking: Now that we have a Driver Console, we need to implement expo-location background tasks to feed live coordinates to the database.

Production Persistence: Replace the MockStorage in firebase.js with expo-secure-store or AsyncStorage for production builds.

Chat Photos: Allow users to upload images directly in the chat (reusing photoService.js).

Agent Directive
When working on this repo:

Respect the Paths: The path names drivers, tours, and users are hardcoded in Security Rules. Changing them in code breaks the app.

Multi-Path Updates: When modifying Driver assignments, ALWAYS use multi-path updates (updating /drivers and /tours simultaneously) to keep data consistent.

Gen 2 Functions: All new backend logic must use Firebase Functions Gen 2 syntax (onValueCreated, etc.).