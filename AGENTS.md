# Loch Lomond Travel (LLT) App - Agent Onboarding & System Status

Welcome, Agent. This document provides a comprehensive overview of the current state of the LLT App ecosystem. It details the architecture, technologies, patterns, known issues, and guidelines for contributing.

**Last Updated:** January 2026

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Directory Structure](#3-directory-structure)
4. [Database Architecture](#4-database-architecture)
5. [Authentication System](#5-authentication-system)
6. [Key Screens & Components](#6-key-screens--components)
7. [Services Layer](#7-services-layer)
8. [Design System (theme.js)](#8-design-system-themejs)
9. [Firebase Cloud Functions](#9-firebase-cloud-functions)
10. [Web Admin Dashboard](#10-web-admin-dashboard)
11. [Firebase Security Rules](#11-firebase-security-rules)
12. [Testing](#12-testing)
13. [Build & Deployment](#13-build--deployment)
14. [Code Patterns & Conventions](#14-code-patterns--conventions)
15. [Known Issues & Watch List](#15-known-issues--watch-list)
16. [Upcoming Roadmap](#16-upcoming-roadmap)
17. [Agent Directives](#17-agent-directives)

---

## 1. System Architecture Overview

The LLT ecosystem is a multi-platform solution consisting of:
- **Mobile App** (React Native/Expo) - For passengers and drivers
- **Web Admin Dashboard** (React/Vite) - For operations staff
- **Serverless Backend** (Firebase Cloud Functions Gen 2)

### Core Data Flow

```
Google Sheets (CMS)
       │
       ▼
Google Apps Script (syncToFirebase)
       │
       ▼
Firebase Realtime Database (Source of Truth)
       │
       ├──► Mobile App (Passengers/Drivers)
       │
       ├──► Web Admin Dashboard (Operations)
       │
       └──► Cloud Functions (Notifications)
              │
              ▼
         Expo Push API
```

### Google Sheets CMS Structure

| Sheet | Purpose |
|-------|---------|
| **Tour Master** | Tour definitions (codes, names, dates, durations) |
| **Itineraries** | Raw text itineraries for each tour |
| **Pax** | Passenger lists, pickup points, booking references |

---

## 2. Technology Stack

### Mobile App

| Category | Technology | Version |
|----------|-----------|---------|
| Framework | React Native | 0.81.5 |
| Platform | Expo SDK | 54 |
| React | React | 19.1.0 |
| Database | Firebase Realtime Database | 9.21.0 |
| Authentication | Firebase Auth (Anonymous) | 9.21.0 |
| Storage | Firebase Cloud Storage | 9.21.0 |
| Maps | react-native-maps | 1.20.1 |
| Push Notifications | expo-notifications | Latest |
| Secure Storage | expo-secure-store | Latest |
| Location | expo-location | Latest |
| Session Storage | @react-native-async-storage/async-storage | 2.2.0 |

### Web Admin Dashboard

| Category | Technology | Version |
|----------|-----------|---------|
| Framework | React | 19.2.0 |
| Build Tool | Vite | 7.2.4 |
| UI Library | Mantine | 8.3.9 |
| Routing | React Router DOM | 7.9.6 |
| Database | Firebase | 12.6.0 |

### Backend

| Category | Technology |
|----------|-----------|
| Functions | Firebase Cloud Functions Gen 2 |
| Notifications | Expo Server SDK |
| Admin SDK | Firebase Admin SDK |
| Region | europe-west1 (Belgium) |

---

## 3. Directory Structure

```
/llt-app-new/
│
├── App.js                          # Main entry point & screen routing
├── index.js                        # Expo root component registration
├── firebase.js                     # Firebase initialization & auth helpers
├── theme.js                        # Centralized design system
│
├── app.json                        # Expo app configuration
├── eas.json                        # EAS build profiles
├── database.rules.json             # Firebase Security Rules
├── firebase.json                   # Firebase Functions deployment config
├── package.json                    # Mobile app dependencies
├── babel.config.js                 # Babel configuration
│
├── screens/                        # UI Screens
│   ├── LoginScreen.js              # Authentication (booking ref / driver code)
│   ├── TourHomeScreen.js           # Passenger main dashboard
│   ├── DriverHomeScreen.js         # Driver console
│   ├── PassengerManifestScreen.js  # Driver boarding manifest
│   ├── ItineraryScreen.js          # Tour timeline/schedule
│   ├── ChatScreen.js               # Group & internal driver chat
│   ├── MapScreen.js                # Live pickup location
│   ├── PhotobookScreen.js          # Personal photo gallery
│   ├── GroupPhotobookScreen.js     # Shared tour photos
│   ├── NotificationPreferencesScreen.js  # User preferences
│   └── SafetySupportScreen.js      # Emergency/safety features
│
├── services/                       # Business logic & API handlers
│   ├── bookingServiceRealtime.js   # Booking validation & tour joining
│   ├── chatService.js              # Chat message operations
│   ├── photoService.js             # Photo upload/management
│   ├── notificationService.js      # Push notification registration
│   ├── loggerService.js            # Centralized logging with persistence
│   ├── safetyService.js            # Safety/emergency features
│   └── persistenceProvider.js      # Multi-layer storage provider
│
├── hooks/                          # Custom React Hooks
│   └── useDiagnostics.js           # Network & Firebase connectivity
│
├── components/                     # Reusable UI Components
│   ├── ImageViewer.js              # Photo gallery viewer
│   ├── TodaysAgendaCard.js         # Schedule/agenda display
│   └── ManifestBookingCard.js      # Booking status card
│
├── assets/                         # Static Assets
│   ├── images/
│   │   └── outward_app_icon.png    # App icon
│   ├── splash.png                  # Splash screen
│   ├── favicon.png
│   └── adaptive-icon.png
│
├── functions/                      # Firebase Cloud Functions
│   ├── index.js                    # Cloud Functions Gen 2 triggers
│   ├── package.json
│   └── package-lock.json
│
├── web-admin/                      # Web Operations Dashboard
│   ├── src/
│   │   ├── App.jsx                 # Main web admin app
│   │   ├── main.jsx                # React entry point
│   │   ├── firebase.js             # Web Firebase config
│   │   ├── components/
│   │   │   ├── DriversManager.jsx  # Driver CRUD operations
│   │   │   ├── ToursManager.jsx    # Tour management
│   │   │   ├── BroadcastPanel.jsx  # System-wide announcements
│   │   │   ├── Dashboard.jsx       # Main operations dashboard
│   │   │   └── Settings.jsx        # Admin settings
│   │   └── services/
│   │       └── tourService.js      # Tour operations helpers
│   ├── vite.config.js
│   └── package.json
│
├── tests/                          # Unit Tests
│   └── joinTour.test.js            # Booking service tests
│
├── __tests__/                      # Additional Tests
│   ├── chatService.test.js
│   └── photoService.test.js
│
├── .env.example                    # Environment variables template
├── .firebaserc                     # Firebase project configuration
└── devcontainer.json               # Dev container setup
```

---

## 4. Database Architecture

### Firebase Realtime Database Structure

```
{
  // Tour definitions synced from Google Sheets
  tours/{tourId}: {
    name: string,
    code: string,
    startDate: string,
    duration: number,
    driverLocation: {
      lat: number,
      lng: number,
      timestamp: number
    },
    currentParticipants: number,
    participants/{userId}: {
      joinedAt: timestamp
    },
    itinerary: {
      stops: [{
        name: string,
        time: string,
        description: string
      }]
    },
    driverInfo: {
      id: string,
      name: string,
      phone: string
    }
  },

  // Booking references linking passengers to tours
  bookings/{bookingRef}: {
    tourCode: string,
    tourId: string,
    passengerNames: string[],
    pickupPoints: [{
      location: string,
      time: string
    }],
    seatNumbers: string[],
    status: 'PENDING' | 'BOARDED' | 'NO_SHOW' | 'PARTIAL'
  },

  // Tour manifests for driver boarding operations
  tour_manifests/{tourId}: {
    assigned_drivers: string[],        // Driver IDs
    assigned_driver_codes: string[],   // Driver codes (D-BONDY)
    bookings/{bookingRef}: {
      status: 'PENDING' | 'BOARDED' | 'NO_SHOW' | 'PARTIAL',
      passengerStatuses: string[]
    }
  },

  // Driver profiles
  drivers/{driverId}: {
    id: string,
    name: string,
    phone: string,
    authUid: string,                   // Firebase Auth UID
    assignedTours: string[],
    currentTourId: string,
    currentTourCode: string
  },

  // Group chat (passengers + drivers)
  chats/{tourId}/messages/{messageId}: {
    senderId: string,
    senderName: string,
    text: string,
    timestamp: number,
    isDriver?: boolean
  },

  // Internal driver-only chat
  internal_chats/{tourId}/messages/{messageId}: {
    senderId: string,
    senderName: string,
    text: string,
    timestamp: number
  },

  // User profiles (push tokens, preferences)
  users/{userId}: {
    pushToken: string,
    preferences: {
      chatNotifications: boolean,
      itineraryNotifications: boolean
    },
    lastUpdated: timestamp,
    deviceOS: string,
    deviceModel: string,
    appVersion: string
  },

  // Shared tour photos
  group_tour_photos/{tourId}/{photoId}: {
    uploaderId: string,
    uploaderName: string,
    url: string,
    timestamp: number
  },

  // Private user photos
  private_tour_photos/{tourId}/{userId}/{photoId}: {
    url: string,
    timestamp: number,
    caption?: string
  },

  // Application logs
  logs/{userId}/{sessionId}/{timestamp}: {
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    component: string,
    message: string,
    data: object,
    timestamp: number,
    sessionId: string,
    deviceInfo: object
  }
}
```

### Database Region

**CRITICAL:** All Firebase resources are in `europe-west1` (Belgium).

All new Cloud Functions MUST explicitly specify the region:
```javascript
exports.myFunction = onValueCreated(
  { ref: '/path/{id}', region: 'europe-west1' },
  async (event) => { ... }
);
```

---

## 5. Authentication System

The app uses a dual authentication system:

### 1. Anonymous Authentication (Foundation)
- All users start with Firebase anonymous sign-in
- Persisted via custom `AuthPersistence` class
- Session restored automatically on app restart

### 2. Passenger Mode (Booking Reference)
```
Login Code Format: T12345, ABC123, etc.
```
- Validates against `/bookings/{bookingRef}`
- Links user UID to tour via booking data
- Stores session in AsyncStorage

### 3. Driver Mode (Hidden)
```
Login Code Format: D-BONDY, D-SMITH, etc.
```
- Any code starting with `D-` triggers driver mode
- Validates against `/drivers/{driverId}`
- Performs multi-path update on successful login:
  - Updates `drivers/{driverId}/authUid`
  - Updates `tour_manifests/{tourId}/assigned_drivers`
  - Updates `tour_manifests/{tourId}/assigned_driver_codes`

### Persistence Provider Hierarchy

The app uses a fallback chain for data persistence:

```javascript
// persistenceProvider.js
1. expo-secure-store    // Primary: encrypted, per-device
2. AsyncStorage         // Fallback: plain storage
3. In-memory mock       // Final: for tests/web
```

---

## 6. Key Screens & Components

### Passenger Screens

| Screen | File | Purpose |
|--------|------|---------|
| Login | `LoginScreen.js` | Authentication via booking ref |
| Tour Home | `TourHomeScreen.js` | Main dashboard with manifest status |
| Itinerary | `ItineraryScreen.js` | Tour schedule and timeline |
| Chat | `ChatScreen.js` | Group chat with driver badges |
| Map | `MapScreen.js` | Live pickup location display |
| Photobook | `PhotobookScreen.js` | Personal photo gallery |
| Group Photos | `GroupPhotobookScreen.js` | Shared tour photos |
| Notifications | `NotificationPreferencesScreen.js` | Push preferences |
| Safety | `SafetySupportScreen.js` | Emergency features |

### Driver Screens

| Screen | File | Purpose |
|--------|------|---------|
| Driver Home | `DriverHomeScreen.js` | Driver console with actions |
| Manifest | `PassengerManifestScreen.js` | Boarding management |

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Today's Agenda | `TodaysAgendaCard.js` | Current day schedule |
| Manifest Card | `ManifestBookingCard.js` | Individual booking status |
| Image Viewer | `ImageViewer.js` | Photo gallery modal |

---

## 7. Services Layer

### bookingServiceRealtime.js
Core booking and tour operations:
- `validateLoginCode(code)` - Determines code type (booking/driver)
- `joinTour(tourId, userId)` - Atomic tour joining with transactions
- `assignDriverToTour(driverId, tourId)` - Multi-path driver assignment
- `updateManifestStatus(tourId, bookingRef, status)` - Boarding updates
- `deriveParentStatusFromPassengers(statuses)` - Status aggregation

### chatService.js
Chat operations:
- `sendMessage(tourId, message)` - Send to group chat
- `sendInternalMessage(tourId, message)` - Driver-only chat
- `subscribeToMessages(tourId, callback)` - Real-time listener

### photoService.js
Photo management:
- `uploadPhoto(tourId, userId, photo)` - Upload to Firebase Storage
- `getGroupPhotos(tourId)` - Fetch shared photos
- `getPrivatePhotos(tourId, userId)` - Fetch user photos

### notificationService.js
Push notification management:
- `registerForPushNotifications()` - Get Expo push token
- `saveUserPreferences(userId, prefs)` - Store preferences
- `updatePushToken(userId, token)` - Update token in Firebase

### loggerService.js
Centralized logging with persistence:
- `log(level, component, message, data)` - Create log entry
- `uploadLogs(userId)` - Sync logs to Firebase
- Maintains local queue (max 1000 entries)
- Auto-uploads WARN+ level logs

### safetyService.js
Emergency and safety features:
- Emergency contact handling
- Safety information display

### persistenceProvider.js
Multi-layer storage abstraction:
- Unified API for secure storage operations
- Automatic fallback between storage providers
- Web compatibility with memory storage

---

## 8. Design System (theme.js)

The app uses a centralized design system for consistency:

### Colors

```javascript
colors: {
  primary: '#1E40AF',        // Deep blue
  primaryLight: '#3B82F6',   // Lighter blue
  accent: '#F97316',         // Orange
  accentLight: '#FB923C',    // Lighter orange

  success: '#10B981',        // Green
  warning: '#F59E0B',        // Amber
  error: '#EF4444',          // Red
  info: '#3B82F6',           // Blue

  background: '#F3F4F6',     // Light gray
  surface: '#FFFFFF',        // White
  surfaceSecondary: '#F9FAFB',

  text: '#111827',           // Near black
  textSecondary: '#6B7280',  // Gray
  textTertiary: '#9CA3AF',   // Light gray
  textOnPrimary: '#FFFFFF',

  border: '#E5E7EB',
  borderLight: '#F3F4F6',
  divider: '#E5E7EB',
}
```

### Manifest Status Colors

```javascript
statusColors: {
  BOARDED: '#10B981',     // Green - passenger boarded
  NO_SHOW: '#EF4444',     // Red - passenger didn't show
  PARTIAL: '#F59E0B',     // Amber - partial boarding
  PENDING: '#6B7280',     // Gray - not yet processed
}
```

### Spacing Scale

```javascript
spacing: {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
}
```

### Border Radius

```javascript
borderRadius: {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
}
```

### Shadows

```javascript
shadows: {
  sm: { shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.05, ... },
  md: { shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.1, ... },
  lg: { shadowOffset: {width: 0, height: 10}, shadowOpacity: 0.1, ... },
  xl: { shadowOffset: {width: 0, height: 20}, shadowOpacity: 0.1, ... },
}
```

---

## 9. Firebase Cloud Functions

Located in `/functions/index.js`. All functions use **Gen 2 syntax**.

### sendChatNotification
Triggered when a new chat message is created:
```javascript
exports.sendChatNotification = onValueCreated(
  { ref: '/chats/{tourId}/messages/{messageId}', region: 'europe-west1' },
  async (event) => { ... }
);
```

### sendItineraryNotification
Triggered when itinerary is updated:
```javascript
exports.sendItineraryNotification = onValueUpdated(
  { ref: '/tours/{tourId}/itinerary', region: 'europe-west1' },
  async (event) => { ... }
);
```

### Key Features
- Respects user notification preferences from `/users/{userId}/preferences`
- Uses Expo Push API for delivery
- Rate limiting (10 requests per 60 seconds per key)
- JSON-formatted logging for debugging

---

## 10. Web Admin Dashboard

Located in `/web-admin/`. Built with React + Vite + Mantine UI.

### Components

| Component | Purpose |
|-----------|---------|
| `Dashboard.jsx` | Main operations overview |
| `DriversManager.jsx` | Create/edit/delete drivers, manage assignments |
| `ToursManager.jsx` | Tour management and status |
| `BroadcastPanel.jsx` | Send HQ announcements to all tours |
| `Settings.jsx` | Admin configuration |

### Running Locally

```bash
cd web-admin
npm install
npm run dev
```

### Key Features
- Driver account management
- Multi-tour driver assignment
- System-wide broadcast messaging
- Real-time tour status monitoring

---

## 11. Firebase Security Rules

Located in `database.rules.json`. These rules enforce access control:

```json
{
  "rules": {
    "drivers": {
      ".read": "auth != null",
      "$driverCode": {
        ".write": "auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' ||
                   data.child('authUid').val() === auth.uid ||
                   newData.child('authUid').val() === auth.uid"
      }
    },

    "bookings": {
      ".read": "auth != null",
      ".indexOn": ["tourCode"],
      "$bookingId": {
        ".write": "auth != null"
      }
    },

    "tour_manifests": {
      ".read": "auth != null",
      ".write": "auth != null",
      "$tourId": {
        "assigned_drivers": {
          ".indexOn": [".value"]
        }
      }
    },

    "tours": {
      ".read": "auth != null",
      ".write": "auth != null",
      "$tourId": {
        ".read": "auth != null && auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'",
        ".write": "auth != null && auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23'"
      }
    },

    "chats": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    "internal_chats": {
      "$tourId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },

    "logs": {
      "$userId": {
        ".read": false,
        ".write": "auth != null || $userId === 'anonymous'"
      }
    },

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

    "users": {
      "$userId": {
        ".read": "auth != null && (auth.uid === $userId ||
                  auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23')",
        ".write": "auth != null && (auth.uid === $userId ||
                   auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23')"
      }
    }
  }
}
```

### Key Rules Summary

| Path | Read | Write |
|------|------|-------|
| `/drivers` | Authenticated | Admin, owner, or claiming |
| `/bookings` | Authenticated | Authenticated |
| `/tour_manifests` | Authenticated | Authenticated |
| `/tours` | Authenticated | Admin only |
| `/chats` | Authenticated | Authenticated |
| `/internal_chats` | Authenticated | Authenticated |
| `/logs` | Never | Anyone (anonymous allowed) |
| `/group_tour_photos` | Authenticated | Authenticated |
| `/private_tour_photos` | Owner only | Owner only |
| `/users` | Self + Admin | Self + Admin |

---

## 12. Testing

### Framework
Node.js built-in `test` module (Node.js 18+)

### Test Files

| File | Purpose |
|------|---------|
| `tests/joinTour.test.js` | Booking service unit tests |
| `__tests__/chatService.test.js` | Chat service tests |
| `__tests__/photoService.test.js` | Photo service tests |

### Running Tests

```bash
npm test
```

### Test Pattern

```javascript
import { test, describe, mock } from 'node:test';
import assert from 'node:assert';

describe('Feature', () => {
  test('should do something', async () => {
    const mockDb = createMockRealtimeDb();
    const result = await someFunction(mockDb);
    assert.strictEqual(result.success, true);
  });
});
```

### Key Test Scenarios (joinTour.test.js)
- Concurrent join handling
- Transaction safety
- Participant count reconciliation
- Booking schema normalization
- Error handling for invalid inputs

---

## 13. Build & Deployment

### Mobile App (EAS)

Build profiles defined in `eas.json`:

| Profile | Purpose | Output |
|---------|---------|--------|
| `development` | Dev client for simulators | APK / Simulator build |
| `development-device` | Dev client for physical devices | APK / IPA |
| `preview` | Internal testing | APK / IPA |
| `production` | App Store / Play Store release | AAB / IPA |

### Build Commands

```bash
# Development builds
npm run build:dev:ios           # iOS simulator
npm run build:dev:android       # Android emulator
npm run build:dev:ios-device    # iOS physical device

# Preview builds
npm run build:preview           # Both platforms

# Production builds
npm run build:production        # Both platforms with auto-versioning
```

### Environment Variables

Environment variables are stored in EAS Secrets (not in repo):

```javascript
// eas.json references
"env": {
  "EXPO_PUBLIC_FIREBASE_API_KEY": "@firebase_api_key",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN": "@firebase_auth_domain",
  // ... etc
}
```

### Web Admin

```bash
cd web-admin
npm run dev       # Development server
npm run build     # Production build
npm run preview   # Preview production build
```

### Firebase Functions

```bash
cd functions
npm run deploy    # Deploy to Firebase
npm run serve     # Local emulator
npm run logs      # View production logs
```

### Starting Development

```bash
# Mobile app
npm install
npm start         # Expo dev server
npm run start:dev # With dev client

# Web admin
cd web-admin
npm install
npm run dev
```

---

## 14. Code Patterns & Conventions

### Multi-Path Updates
Always use multi-path updates for data consistency across nodes:

```javascript
const updates = {};
updates[`drivers/${driverId}/currentTourId`] = tourId;
updates[`tour_manifests/${tourId}/assigned_drivers/${driverId}`] = true;
updates[`tour_manifests/${tourId}/assigned_driver_codes`] = arrayUnion(driverCode);
await realtimeDb.ref().update(updates);
```

### Transaction-Based Operations
Use transactions for atomic counter updates:

```javascript
await realtimeDb.ref(`tours/${tourId}/currentParticipants`).transaction(current => {
  return (current || 0) + 1;
});
```

### Tour Code Sanitization
Normalize tour codes for use as Firebase keys:

```javascript
// "5112D 8" -> "5112D_8"
const sanitizeTourId = (tourCode) => {
  return tourCode.replace(/\s+/g, '_').toUpperCase();
};
```

### Manifest Status Derivation
Aggregate passenger statuses to parent booking status:

```javascript
const deriveParentStatusFromPassengers = (passengerStatuses) => {
  const allBoarded = passengerStatuses.every(s => s === 'BOARDED');
  const allNoShow = passengerStatuses.every(s => s === 'NO_SHOW');
  const allPending = passengerStatuses.every(s => s === 'PENDING');

  if (allBoarded) return 'BOARDED';
  if (allNoShow) return 'NO_SHOW';
  if (allPending) return 'PENDING';
  return 'PARTIAL';
};
```

### Service Return Pattern
Services return consistent response objects:

```javascript
return { success: true, data: result };
return { success: false, error: 'Error message' };
```

### Structured Logging
Use loggerService for consistent logging:

```javascript
import { logger } from '../services/loggerService';

logger.info('ChatScreen', 'Message sent', { tourId, messageId });
logger.error('ChatScreen', 'Failed to send message', { error: e.message });
```

### Date Parsing (UK Format)
**CRITICAL:** Always parse dates manually due to UK format (dd/MM/yyyy):

```javascript
// CORRECT
const [day, month, year] = dateString.split('/').map(Number);
const date = new Date(year, month - 1, day);

// WRONG - will parse as US format
const date = new Date(dateString);
```

### Navigation Pattern
The app uses manual screen management (no React Navigation):

```javascript
// In App.js
const navigateTo = (screen, params = {}) => {
  setScreenParams(params);
  setCurrentScreen(screen);
  saveSession({ screen, params });
};
```

### Firebase Listeners
Set up and clean up listeners properly:

```javascript
useEffect(() => {
  const unsubscribe = realtimeDb
    .ref(`chats/${tourId}/messages`)
    .on('value', (snapshot) => {
      // Handle data
    });

  return () => {
    realtimeDb.ref(`chats/${tourId}/messages`).off('value', unsubscribe);
  };
}, [tourId]);
```

---

## 15. Known Issues & Watch List

### Date Parsing (UK vs US)
- **Issue:** JavaScript `Date()` defaults to US format (MM/dd/yyyy), but backend data uses UK format (dd/MM/yyyy)
- **Solution:** Always use manual parsing: `split('/').map(Number)`
- **Reference:** See `ItineraryScreen.js` for correct implementation

### Firebase Region Mismatch
- **Issue:** Functions in wrong region cause "database mismatch" errors
- **Solution:** All Cloud Functions must specify `.region("europe-west1")`

### Expo Push Token Expiration
- **Issue:** Push tokens can expire or become invalid
- **Solution:** Re-register token on each app launch and handle invalid token errors

### Offline Mode Limitations
- **Issue:** App requires network for most operations
- **Status:** Partial offline support via Firebase persistence
- **Future:** Enhanced caching for Itinerary and Tickets (see Roadmap)

### Driver Assignment Race Conditions
- **Issue:** Concurrent driver assignments could cause data inconsistency
- **Solution:** Always use `assignDriverToTour()` helper which performs atomic multi-path updates

---

## 16. Upcoming Roadmap

### Production Persistence
Replace MockStorage fallback with robust production storage. Ensure users stay logged in across app restarts reliably.

### Chat Media
Enable photo uploads directly within the Chat interface, reusing `photoService.js` infrastructure.

### Offline Mode
Enhance caching for Itinerary and Tickets so the app works without signal in the Scottish Highlands.

### Push Notification Improvements
- Notification grouping by tour
- Quiet hours support
- Enhanced delivery tracking

### Driver Features
- Route optimization suggestions
- Automated boarding reminders
- Driver shift management

---

## 17. Agent Directives

When working on this repository, follow these critical guidelines:

### 1. Respect Database Paths
The paths `drivers`, `tours`, `users`, `bookings`, and `tour_manifests` are hardcoded in Security Rules. Do not rename them.

### 2. Multi-Path Updates
When modifying driver assignments, ALWAYS use multi-path updates to keep `/drivers`, `/tours`, and `/tour_manifests` in sync:

```javascript
// CORRECT
await assignDriverToTour(driverId, tourId);

// WRONG - will cause data inconsistency
await db.ref(`drivers/${id}/currentTourId`).set(tourId);
```

### 3. Gen 2 Functions
All new backend logic must use Firebase Functions Gen 2 syntax:

```javascript
// CORRECT - Gen 2
exports.myFunction = onValueCreated(
  { ref: '/path/{id}', region: 'europe-west1' },
  async (event) => { ... }
);

// WRONG - Gen 1 (deprecated)
exports.myFunction = functions.database.ref('/path/{id}').onCreate(...);
```

### 4. Region Specification
Always specify `europe-west1` region for Cloud Functions:

```javascript
{ ref: '/path', region: 'europe-west1' }
```

### 5. Date Handling
Never use `new Date(dateString)` for UK-formatted dates. Always parse manually:

```javascript
const [day, month, year] = dateString.split('/').map(Number);
```

### 6. Theme Consistency
Use values from `theme.js` for all styling. Don't hardcode colors or spacing:

```javascript
// CORRECT
import theme from '../theme';
style={{ backgroundColor: theme.colors.primary, padding: theme.spacing.md }}

// WRONG
style={{ backgroundColor: '#1E40AF', padding: 12 }}
```

### 7. Error Handling
Return consistent response objects from services:

```javascript
return { success: true, data: result };
return { success: false, error: 'Descriptive error message' };
```

### 8. Logging
Use `loggerService` for all logging needs:

```javascript
import { logger } from '../services/loggerService';
logger.info('ComponentName', 'Action description', { relevantData });
```

### 9. Testing
Write tests for new functionality using the Node.js test framework pattern established in `tests/joinTour.test.js`.

### 10. Environment Variables
Never commit secrets. Use EAS Secrets for environment variables in builds.

---


### Offline Tour Pack (January 2026)

- `services/offlineSyncService.js` now manages Tour Pack cache and an offline action queue.
- Queue action types:
  - `MANIFEST_UPDATE`
  - `CHAT_MESSAGE`
  - `INTERNAL_CHAT_MESSAGE`
- Replay policy:
  - FIFO execution by `createdAt`
  - single-run lock (no parallel replay)
  - retry-bounded (max 5 attempts)
  - local processed action IDs prevent duplicate replay after restart
- Manifest conflict policy:
  - compare local `lastUpdated` with server `lastUpdated`
  - prefer most recent timestamp
  - if server wins, reconcile and log event
  - user note: "One update was reconciled with newer server data."

## Quick Reference

### Common Commands

```bash
# Start development
npm start                    # Expo dev server
npm run start:dev           # With dev client

# Build
npm run build:dev:ios       # iOS simulator build
npm run build:preview       # Internal testing
npm run build:production    # Production release

# Test
npm test                    # Run unit tests

# Web Admin
cd web-admin && npm run dev # Start admin dashboard

# Functions
cd functions && npm run deploy  # Deploy Cloud Functions
```

### Key Files to Know

| File | Purpose |
|------|---------|
| `App.js` | Main entry, routing, session management |
| `firebase.js` | Firebase initialization, auth helpers |
| `theme.js` | Design system constants |
| `services/bookingServiceRealtime.js` | Core booking logic |
| `screens/DriverHomeScreen.js` | Driver console |
| `screens/TourHomeScreen.js` | Passenger dashboard |
| `functions/index.js` | Cloud Functions |
| `database.rules.json` | Security rules |

### Admin UID

The hardcoded admin UID in security rules: `9CWQ4705gVRkfW5Xki5LyvrmVp23`

---

*This document should be updated whenever significant changes are made to the codebase architecture, database structure, or development patterns.*
