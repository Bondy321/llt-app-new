Loch Lomond Travel (LLT) App - Agent Onboarding & System Status

Last Updated: 28th November 2025

Welcome, Agent. This document provides a comprehensive overview of the current state of the LLT App ecosystem. It details the architecture, recent critical updates, known issues, and the roadmap for upcoming features.

1. System Architecture Overview

The LLT App is a companion application for tour passengers, built with React Native (Expo) and backed by Firebase (Realtime Database & Authentication) and Google Sheets (as the CMS).

Core Data Flow

Google Sheets (The CMS):

Master Sheet: Tour Master contains all tour definitions (codes, names, dates, durations).

Itinerary Sheet: Itineraries contains raw text itineraries.

Passenger Sheet: Pax contains passenger lists, pickup points, and booking references.

Sync Engine: A Google Apps Script (syncToFirebase) parses this data and pushes it to Firebase.

Firebase Realtime Database:

Acts as the middleware between the Sheet and the App.

Structure:

/tours/{tourId}: Contains tour details, driver info, and the new structured itinerary object.

/bookings/{bookingRef}: Links users to tours via their booking reference.

/chats/{tourId}: Stores group chat messages.

/photos/{tourId}: Stores metadata for the shared photo album.

React Native App:

Login: Users log in with a Booking Reference (e.g., T12345).

Home: Displays a digital boarding pass, tour details, and the new "Today's Agenda" widget.

Features: Itinerary view, Group Chat, Photo Sharing, and Driver Location (placeholder).

2. Recent Critical Updates (The "Itinerary 2.0" Overhaul)

We have just completed a major refactor of how itineraries are handled to move away from unstructured text blocks to a smart, JSON-based system.

A. Backend (Google Apps Script)

Old Behavior: Sent raw text strings to Firebase.

New Behavior: The script now includes a parseRawItinerary function.

It regex-matches "Day 1", "Day 2" etc.

It extracts specific times (e.g., "09:00", "1430hrs") from text lines.

It pushes a JSON object: { days: [{ day: 1, title: "...", activities: [...] }] }.

Date Fix: We fixed a timezone bug where tour end dates were calculating incorrectly due to BST/GMT midnight offsets. It now forces UTC noon calculation.

B. Frontend (React Native)

screens/ItineraryScreen.js:

Now expects a JSON object, not a string.

Smart Rendering: Displays time in a dedicated column if available; collapses the column if no time is specified.

Major Events: Automatically highlights key events (Ferries, Flights, Museums) with a distinct visual style.

Date Awareness: Uses tourData.startDate to convert "Day 1" into "Day 1 - Mon 12th July".

Hook Safety: Fixed a "Rendered more hooks" crash by ensuring useMemo is called unconditionally at the top level.

services/bookingServiceRealtime.js:

Hybrid Support: The getTourItinerary function now checks if the data is an Object (new format) or a String (old format).

If Object: Returns it directly.

If String: Falls back to the old regex parser (legacy support).

screens/TourHomeScreen.js:

New Widget: Added TodaysAgendaCard.

Functionality: Calculates the current day of the tour based on startDate vs new Date().

States:

Future: Shows a countdown ("5 days to go!").

Active: Shows specific agenda for "Today".

Completed: Hides the widget.

3. Current Codebase Status

Tech Stack: React Native (Expo SDK 52), Firebase JS SDK (Modular), Google Apps Script.

Auth: Anonymous Auth + Custom Claims (via Edge Function concepts, currently simulated or direct).

Styling: Custom StyleSheet objects using a consistent COLORS palette.

Navigation: React Navigation (Stack).

Key Files

App.js: Main entry, auth loading, navigation routing.

screens/ItineraryScreen.js: The new smart itinerary viewer.

screens/TourHomeScreen.js: The dashboard with the new Agenda Widget.

components/TodaysAgendaCard.js: [NEW] The logic for the home screen widget.

services/bookingServiceRealtime.js: The data layer for fetching/parsing tour data.

4. Known Issues & "Watch List"

Date Parsing (UK vs US):

We use UK dates (dd/MM/yyyy) in the backend.

JS Date() often defaults to US format (MM/dd/yyyy).

Status: We have implemented manual parsing logic (split('/').map(Number)) in ItineraryScreen and TodaysAgendaCard to prevent Invalid Date crashes on Android/iOS. Always ensure any new date logic uses this manual parsing.

Driver Map:

The MapScreen.js is currently a placeholder.

Constraint: This feature is "No Go" for now until the app is production-ready. Do not attempt to implement live tracking yet.

Legacy Itineraries:

Tours synced before the App Script update still have string-based itineraries. The app supports them via fallback logic, but they won't look as good as the new ones.

5. Upcoming Roadmap

Production Polish: Continue refining UI/UX.

Driver App/Tracking: Once the Passenger App is stable, we will build the Driver side to feed coordinates to MapScreen.

Photo Uploads: Ensure the PhotoService is robust (currently using base64/storage mock concepts; needs firming up for production Firebase Storage).

Agent Directive: When working on this repo, always assume the itinerary data structure is the new JSON format, but respect the legacy fallback in the service layer. Prioritize "UK Date" compatibility in all new date-related features.