Loch Lomond Travel (LLT) App - Agent Onboarding & System Status

Last Updated: 1st December 2025

Welcome, Agent. This document provides a comprehensive overview of the current state of the LLT App ecosystem. It details the architecture, recent critical updates, known issues, and the roadmap for upcoming features.

1. System Architecture Overview

The LLT ecosystem has evolved into a multi-platform solution consisting of a mobile app (for passengers and drivers), a web dashboard (for operations), and a serverless backend.

Core Data Flow

Google Sheets (The CMS):

Master Sheet: Tour Master contains all tour definitions (codes, names, dates, durations).

Itinerary Sheet: Itineraries contains raw text itineraries.

Passenger Sheet: Pax contains passenger lists, pickup points, and booking references.

Sync Engine: A Google Apps Script (syncToFirebase) parses this data and pushes it to Firebase.

Firebase Realtime Database:

The central source of truth.

Structure:

/tours/{tourId}: Tour details, driver info, itinerary, and live location.

/bookings/{bookingRef}: Links users to tours.

/drivers/{driverId}: [NEW] Driver profiles, phone numbers, and assigned tours.

/chats/{tourId}: Group chat messages.

/logs/{userId}: User-specific app logs.

/users/{userId}: Expo Push Tokens and notification preferences.

/group_tour_photos/{tourId}: Metadata for shared group photos.

/private_tour_photos/{tourId}/{userId}: Metadata for private user photos.

Firebase Cloud Functions (Gen 2):

Triggers: Listens for database events (new chat messages, itinerary updates) and sends Push Notifications via Expo.

Region: europe-west1 (Belgium).

Web Admin Dashboard:

A React-based Operations Console (web-admin/) for creating drivers, managing assignments, and sending system-wide broadcasts.

React Native App:

Single Binary Strategy: One app serves both Passengers and Drivers.

Passenger Mode: Login via Booking Ref (e.g., T12345).

Driver Mode: Hidden login via Driver Code (e.g., D-BONDY) routes to DriverHomeScreen.

2. Recent Critical Updates

A. The Driver Ecosystem

We have successfully implemented a "Hidden Driver Mode".

Login: Inputting a code starting with D- unlocks the Driver Console.

Driver Console: Allows drivers to:

Set Pickup Point: Captures GPS coordinates and updates /tours/{tourId}/driverLocation.

Edit Itinerary: Drivers can modify timelines directly in the app. Changes trigger push notifications to passengers.

Driver Chat: Drivers can participate in group chats with a distinct "DRIVER" badge.

B. Live Map (Pickup Points)

Driver Side: "Set Pickup Point" button writes static coordinates to Firebase.

Passenger Side: MapScreen.js displays a marker for the bus location with a "Last Updated" timestamp. This replaces continuous tracking to save battery and reduce complexity.

C. Web Admin Dashboard

We have deployed a React/Vite web app for operations staff (web-admin/).

Driver Management: Create driver accounts and assign them to multiple tours.

Broadcast System: Send "HQ Announcements" that appear in tour chats as high-priority messages.

Data Integrity: Uses multi-path updates to ensure /drivers and /tours data remains consistent.

D. Notification Infrastructure (Backend)

Triggers: sendChatNotification and sendItineraryNotification Cloud Functions (Gen 2).

Logic: Respects user preferences stored in /users/{userId}/preferences.

Delivery: Uses Expo Push API for reliable delivery to iOS/Android.

3. Firebase Security Rules (Reference)

CRITICAL: These rules enforce the separation of powers between Passengers, Drivers, and Admins.

{
  "rules": {
    // Helper: Check if user is the specific Admin UID
    // REPLACE 'YOUR_ADMIN_UID_HERE' with the actual UID from Firebase Auth
    // In production, use a custom claim or list of admin UIDs
    
    // 1. DRIVERS
    // App needs to read to verify login. ONLY Admin can write/create drivers.
    "drivers": {
      ".read": "auth != null",
      ".write": "auth.uid === 'YOUR_ADMIN_UID_HERE'"
    },

    // 2. BOOKINGS
    "bookings": {
      "$bookingId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    // 3. TOURS
    // Passengers read. Drivers/Admins can write (for location/itinerary updates).
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
        ".read": "auth != null && (auth.uid === $userId || auth.uid === 'YOUR_ADMIN_UID_HERE')",
        ".write": "auth != null && (auth.uid === $userId || auth.uid === 'YOUR_ADMIN_UID_HERE')"
      }
    }
  }
}


4. Current Codebase Status

Tech Stack: React Native (Expo SDK 52), Firebase Cloud Functions (Gen 2), React (Vite) for Admin.

Key Files

App.js: Main entry point, handles routing between Passenger/Driver modes.

functions/index.js: [Backend] Cloud Functions triggers for Chat and Itinerary notifications.

web-admin/src/components/DriversManager.jsx: [Backend UI] Logic for managing driver assignments.

screens/DriverHomeScreen.js: The dedicated dashboard for drivers.

screens/MapScreen.js: Displays the driver's set pickup location.

services/bookingServiceRealtime.js: Handles logic for validating generic login codes.

5. Known Issues & "Watch List"

Date Parsing (UK vs US)

Issue: JS Date() defaults to US format (MM/dd/yyyy), but backend data is UK (dd/MM/yyyy).

Directive: Always use the manual parsing logic provided in ItineraryScreen.js (split('/').map(Number)).

Firebase Region

Status: Database and Functions are in europe-west1 (Belgium).

Directive: Ensure all future Cloud Functions explicitly state .region("europe-west1") to avoid "database mismatch" errors.

6. Upcoming Roadmap

Production Persistence: Replace the MockStorage in firebase.js with expo-secure-store or AsyncStorage for production builds to ensure users stay logged in.

Chat Media: Enable photo uploads directly within the Chat interface (reusing photoService.js).

Offline Mode: Enhance caching for Itinerary and Tickets so the app works without signal in the Highlands.

Agent Directive

When working on this repo:

Respect the Paths: The path names drivers, tours, and users are hardcoded in Security Rules.

Multi-Path Updates: When modifying Driver assignments in the Admin panel, ALWAYS use multi-path updates (updating /drivers and /tours simultaneously) to keep data consistent.

Gen 2 Functions: All new backend logic must use Firebase Functions Gen 2 syntax (onValueCreated, onValueUpdated).