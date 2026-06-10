# App Store Connect Privacy Responses

Last updated: 2026-06-10

Use this alongside the generated iOS privacy report from the production archive. The responses below are based on the current repo audit for the LLT mobile app, Firebase backend, Expo push/updates, chat, photos, safety, location, diagnostics, and notification preference code.

## Tracking

- Tracking: No.
- IDFA / Advertising Identifier: No.
- Cross-app or cross-site tracking: No.
- Data brokers or third-party advertising networks: none found in current app code/dependencies.

If any ads, attribution SDKs, IDFA, data broker sharing, or cross-app analytics are added later, update the privacy policy, App Store privacy answers, and ATT implementation before release.

## Data Linked To The User

Mark the following as linked to the user because they are associated with Firebase auth UID, booking identity, driver identity, tour ID, push token, or app account records.

| App Store category | Data to disclose | Primary purpose |
| --- | --- | --- |
| Contact Info | Booking email, passenger names/booking identity where shown in manifest data, support/data request email interactions if handled through app mail handoff | App Functionality, Customer Support |
| Identifiers | Firebase anonymous auth UID, stable passenger ID, driver principal ID, push token, diagnostic/session IDs when uploaded | App Functionality, Developer Support |
| Location | Driver pickup/bus location, optional safety report coordinates, optional live-location sharing, passenger location when transmitted by a selected safety/live feature | App Functionality, Safety, Customer Support |
| User Content | Chat messages, replies, reactions, deleted-message state, photos, captions, safety report text, trusted-contact content if included in support/safety flows, content reports | App Functionality, Safety, Customer Support |
| Photos or Videos | Group/private/chat photo uploads and photo metadata | App Functionality |
| Diagnostics | Crash snapshots, app logs, login diagnostics, operational alerts, app/device metadata attached to diagnostics | App Functionality, Developer Support |
| Usage Data | App interaction data contained in remote logs/diagnostics, notification preference interactions, sync/queue state | App Functionality, Developer Support |
| Sensitive Info | Safety/SOS report content may contain sensitive incident, medical, harassment, or emergency information if the user enters it | Safety, Customer Support |

## Data Not Used For Tracking

All disclosed data above should be marked as not used for tracking unless Loch Lomond Travel later shares it with third parties for advertising, attribution, data brokering, or cross-app/site profiling.

## Purposes

- App Functionality: login, itinerary, pickup, map, driver location, manifest, chat, photo, offline cache, notifications, safety support, account deletion.
- Customer Support: support email handoff, safety report review, content reports, diagnostics used to resolve user issues.
- Developer Support / App Performance: crash diagnostics, logs, operational alerts, app/device metadata, sync diagnostics.
- Product Personalization: leave off unless the current notification-interest categories are treated as personalization in App Store Connect. If enabled, limit it to user-selected notification/tour-interest preferences.
- Analytics: use only if App Store Connect treats remote diagnostic/usage logs as analytics. The current code does not show a separate analytics SDK implementation.
- Developer Advertising or Marketing: use only for optional future-tour notification interests if those are classified as marketing in App Store Connect. Do not mark tracking.

## Data Not Observed In Current Code

No current evidence was found for paid digital content, subscriptions, IAP, third-party social login, HealthKit, Apple Pay, gambling, VPN, Kids Category, IDFA, AdSupport, third-party ad SDKs, or cross-app tracking.

## Required Cross-Checks Before Submission

- Compare these answers to the generated archive privacy report from Xcode Organizer or the EAS/Xcode workflow.
- Confirm Firebase, Expo, React Native, Hermes, and Expo native package privacy manifests/signatures are present in the production archive.
- Confirm App Store Connect privacy answers match `docs/Loch_Lomond_Travel_App_Privacy_Policy.html` and the hosted PDF URL.
- Re-run this audit if dependencies, analytics, ads, payments, social login, or location behavior changes.
