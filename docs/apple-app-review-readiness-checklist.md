# Apple App Review Readiness Checklist

Last researched: 2026-06-10

This checklist is for the LLT iOS App Store submission. No checklist can guarantee approval because Apple review includes human judgment, changing policy interpretation, and live app behavior during review. The goal here is to remove the known rejection paths Apple documents and the app-specific risks visible in this codebase.

## Current App Profile

- App: `LLT` / Loch Lomond Travel
- Bundle ID: `com.lochlomondtravel.tourapp`
- Stack: Expo SDK 55 / React Native 0.83 / Firebase / EAS
- iOS config: portrait, tablet support enabled, iOS deployment target `15.1`
- Current app version/build in config: `1.0.2` / `3`
- Account model: Firebase anonymous auth plus passenger booking reference/email or driver `D-` code
- Apple-sensitive features found in code: account deletion, camera, photo library, photo saving, foreground location, live location sharing, push notifications, chat, user-uploaded photos, diagnostics/logs, Firebase backend, Expo Updates
- Likely no IAP, ads, ATT, social login, HealthKit, Apple Pay, gambling, VPN, or Kids Category functionality based on current dependencies and searches

## Primary Apple Sources

- App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- App Review overview: https://developer.apple.com/distribute/app-review/
- Submit an app: https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app/
- Submission overview/statuses: https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review/
- App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
- Manage app privacy: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/
- Third-party SDK requirements: https://developer.apple.com/support/third-party-SDK-requirements/
- Account deletion requirement: https://developer.apple.com/support/offering-account-deletion-in-your-app/
- Export compliance: https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/
- Accessibility Nutrition Labels: https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels/

## Apple Review Process

- [ ] Create/verify the App Store Connect app record with matching bundle ID `com.lochlomondtravel.tourapp`.
- [ ] Upload a production iOS build through EAS.
- [ ] Wait for build processing to finish in App Store Connect/TestFlight.
- [ ] Fill all required app metadata, screenshots, privacy, age rating, pricing/availability, export compliance, and review contact fields.
- [ ] Select the processed build for the app version.
- [ ] Click `Add for Review`, then submit the draft submission.
- [ ] Monitor statuses: `Waiting for Review`, `In Review`, `Rejected`, `Accepted`, `Pending Developer Release`, `Ready for Distribution`.
- [ ] If rejected for metadata only, fix metadata and resubmit same build where allowed.
- [ ] If rejected for binary behavior, upload a new build and include exact review-note changes.

## Non-Negotiable First-Submission Blockers

- [ ] Privacy policy is rewritten for the mobile app, not just the travel business website/PDF.
- [ ] App Privacy Nutrition Label exactly matches this app and all third-party SDK behavior.
- [ ] App Review has working passenger and driver review credentials or a fully featured demo mode.
- [ ] Backend data for reviewer credentials is live, seeded, and stable throughout review.
- [ ] User-generated chat/photo content has moderation/report/block/contact coverage.
- [ ] Account deletion works from inside the app and is documented in review notes.
- [ ] Purpose strings mention every real use of camera, photos, and location.
- [ ] A production/TestFlight build has been tested on real iPhone and iPad devices.
- [ ] Review notes explain non-obvious booking, driver, location, safety, and notification behavior.

## Privacy Policy Checklist

Current finding: the configured privacy URL is reachable, but the PDF appears to be a general travel-company policy. It does not appear sufficient for this mobile app because Apple requires the policy to identify app/service data, collection methods, uses, third-party sharing, retention/deletion, and consent withdrawal.

- [ ] Host a mobile-app-specific privacy policy at a stable HTTPS URL.
- [ ] Link the same policy from App Store Connect and `Account & privacy` in the app.
- [ ] Identify all app data collected or processed:
  - [ ] Booking reference, booking email, passenger identity, driver identity.
  - [ ] Firebase anonymous auth UID and app account records.
  - [ ] Itinerary/tour/manifest data shown or cached in the app.
  - [ ] Chat messages, replies, reactions, deleted-message state.
  - [ ] Group/private photos, captions, storage metadata, upload timestamps.
  - [ ] Camera/photo-library access and saved photo behavior.
  - [ ] Push token, notification preferences, marketing-interest categories.
  - [ ] Device OS, model, app version/build, OS version.
  - [ ] Diagnostics, login diagnostics, crash snapshots, app logs, ops alerts.
  - [ ] Precise/coarse location for bus pickup, driver sharing, safety reports, live location, SOS options.
  - [ ] Trusted emergency contacts if stored by the safety feature.
- [ ] Explain whether each data type is required, optional, or feature-triggered.
- [ ] Identify third parties/processors: Firebase/Google Cloud, Expo push/EAS Updates where applicable, Apple Maps/MapKit, Google Maps if used on Android, app hosting/support providers, any analytics/diagnostics processor.
- [ ] Confirm third parties provide same/equal protection as the policy states.
- [ ] State that no cross-app/site tracking or IDFA use occurs unless that changes.
- [ ] State retention rules for app account records, logs, push tokens, photos, chat, safety events, cached/offline data, and booking/legal/accounting records.
- [ ] Explain in-app account deletion path and what may be retained for travel operations, safety, legal, or accounting reasons.
- [ ] Explain how users withdraw consent for notifications, location, photos, camera, and marketing notices.
- [ ] Include data request/support email and legal entity/contact details.
- [ ] Address children/minors if bookings can include children, even though the app should not be positioned as Kids Category.

## App Privacy Nutrition Label

Use Xcode/EAS privacy reports and code audit to answer App Store Connect. Err on the inclusive side. Data processed only on-device does not need disclosure, but data sent to Firebase/Expo/other servers does.

- [ ] Contact Info: disclose email and any names/phone numbers used by login, manifest, support, trusted contacts, or booking data.
- [ ] Identifiers: disclose Firebase auth UID, push token, diagnostic/session IDs if stored server-side.
- [ ] Location: disclose precise location if driver/passenger coordinates are transmitted or stored; disclose coarse location if only coarse/derived location is stored.
- [ ] User Content: disclose chat messages, photos, captions, reactions, safety reports, free-text content, and trusted-contact content.
- [ ] Photos/Videos: disclose uploaded tour/chat photos.
- [ ] Diagnostics: disclose crash data, logs, login diagnostics, and other diagnostic data sent off-device.
- [ ] Usage Data: disclose product interaction/screen/activity data if remote logs or diagnostics include it.
- [ ] Sensitive Info: assess safety/SOS/medical categories and any disability/dietary/passport/booking fields surfaced or transmitted by the app.
- [ ] Data linked to the user: mark linked for account, booking, push, chat, photo, location, safety, and diagnostic data associated with UID/booking/driver/tour.
- [ ] Purposes: mark App Functionality for core operational data; Product Personalization only if used; Developer Advertising or Marketing for future-tour notification interests; Analytics only if remote logs/diagnostics are used analytically.
- [ ] Tracking: answer No unless data is linked with third-party data for ads/measurement or shared with data brokers. If any SDK tracks, add ATT prompt and `NSUserTrackingUsageDescription`.
- [ ] Validate that the privacy policy and nutrition label do not contradict each other.

## Privacy Manifests, SDKs, And Required-Reason APIs

- [ ] Generate the iOS archive privacy report from Xcode Organizer or EAS/Xcode workflow.
- [ ] Verify all required third-party SDK privacy manifests and signatures are present.
- [ ] Confirm required-reason API usage is declared in `PrivacyInfo.xcprivacy` where needed.
- [ ] Pay special attention to SDKs/dependencies Apple lists as common privacy-impacting SDKs, including Firebase-family packages, Hermes, and React Native/Expo native packages where present in the generated iOS build.
- [ ] Ensure no SDK includes fingerprinting behavior. ATT disclosure does not fix fingerprinting.
- [ ] Confirm no IDFA/AdSupport/tracking domains are included unless intentionally implemented and disclosed.
- [ ] Keep dependency versions current enough that their privacy manifests/signatures are available.

## App Access For Review

- [ ] Create a reviewer passenger booking reference and email.
- [ ] Create a reviewer driver `D-` code.
- [ ] Seed a live demo tour with itinerary, pickup location, driver details, chat, photos, manifest, and notifications test data.
- [ ] Ensure review accounts never expire during review.
- [ ] Ensure Apple reviewers can complete first launch, login, home, itinerary, map, chat, photos, notifications, safety, account privacy, and account deletion.
- [ ] Provide App Review Notes with exact routes and credentials.
- [ ] If legal/security prevents real accounts, build a full demo mode and obtain Apple acceptance before relying on it.

Suggested review note:

```text
LLT is a closed-access travel operations app for Loch Lomond Travel passengers and drivers.

Passenger demo:
Booking reference: [FILL]
Booking email: [FILL]

Driver demo:
Driver code: [FILL]

Suggested review path:
1. Log in as passenger to view Tour Home, Itinerary, Find My Bus, Group Chat, Photos, Notifications, Safety Support, and Account & privacy.
2. Log out, then log in as driver with the D-code to review driver itinerary, passenger manifest, pickup-location sharing, internal chat, and safety tools.
3. Account deletion is under the account menu > Account & privacy > Delete account.

Notes:
- The SOS screen opens emergency options and can open the phone dialer/SMS composer. It does not contact emergency services automatically.
- Location is requested only for Find My Bus, pickup-location sharing, directions, and safety/live-location features.
- Push notifications are optional and controlled in Notification Preferences.
```

## Login And Account Rules

- [ ] Confirm login is justified by significant account-based features: private itinerary, passenger/driver role, tour data, chat, photos, safety features.
- [ ] App description/review notes explain that public users need a valid booking or driver code.
- [ ] No Sign in with Apple requirement is triggered because the app uses its own booking/driver access system and no third-party social login.
- [ ] If Google/Facebook/other social login is added later, add Sign in with Apple or meet an Apple exception.
- [ ] Account deletion is easy to find after login.
- [ ] Account deletion removes the app account and associated app data where not legally/operationally retained.
- [ ] Account deletion does not only deactivate the account.
- [ ] Account deletion succeeds on a real production-like backend.
- [ ] Deletion clears local stores, auth state, push token/preferences, logs, tour pack, and owned photos where applicable.
- [ ] Deletion gracefully explains retained booking/legal/operations data.

## User-Generated Content: Chat And Photos

Apple requires UGC apps to include filtering, reporting, blocking, published contact info, and timely response. Current code shows delete-own-message/delete-own-photo behavior, but a report/block/moderation flow was not obvious in the search results.

- [ ] Add or verify profanity/objectionable-content filtering before chat/photo/caption submission.
- [ ] Add a visible `Report` action for chat messages and group photos.
- [ ] Route reports to operations/admin with timestamp, reporter, content ID, tour ID, and reason.
- [ ] Add admin/operator ability to remove reported content.
- [ ] Add user block/mute capability, or document why closed tour groups use an equivalent abuse-prevention mechanism accepted by Apple.
- [ ] Publish support/contact information in app and privacy policy.
- [ ] Test reported content removal across Firebase rules and UI refresh.

## Permissions And Purpose Strings

Current purpose strings are present, but location should mention safety/live sharing and photo/camera should mention chat/group/private uploads if those are real user paths.

- [ ] `NSCameraUsageDescription` clearly states camera is used to capture tour/chat photos.
- [ ] `NSPhotoLibraryUsageDescription` clearly states photo library is used to select/upload tour/chat photos.
- [ ] `NSPhotoLibraryAddUsageDescription` clearly states saving tour photos to the user library.
- [ ] `NSLocationWhenInUseUsageDescription` clearly states location is used for bus finding, meeting points, driver pickup sharing, and optional safety/live-location features.
- [ ] No background location entitlement/mode is enabled unless truly required.
- [ ] App works when camera access is denied.
- [ ] App works when photo access is denied or limited.
- [ ] App works when location is denied, with manual/alternative paths where possible.
- [ ] Notifications are optional and not required to access core functionality.

## Safety And Emergency Features

- [ ] Metadata does not imply the app automatically dispatches emergency services.
- [ ] SOS copy continues to state that the app does not contact 999 automatically.
- [ ] Emergency call action opens the phone dialer only after user confirmation.
- [ ] SMS action opens a composer; user sends it manually.
- [ ] Location use for safety is explicit and optional except where directly needed.
- [ ] Safety reports distinguish operational support from emergency services.
- [ ] Review notes explain this behavior.

## Metadata And Product Page

- [ ] App name is unique, accurate, and no more than 30 characters.
- [ ] Subtitle is accurate and no more than 30 characters.
- [ ] Description accurately explains closed-access passenger/driver app behavior.
- [ ] Description does not promise unsupported features.
- [ ] Keywords are accurate, under 100 bytes, and do not include competitor/trademark stuffing.
- [ ] Category is likely `Travel` or `Navigation`; choose the best fit.
- [ ] Support URL is live and app-specific.
- [ ] Marketing URL is live if used.
- [ ] Privacy Policy URL is live and app-specific.
- [ ] Screenshots show the app in use, not only splash/login.
- [ ] Screenshots use fictional/demo data, not real passenger data.
- [ ] Screenshots match device type and supported form factors.
- [ ] If iPad support remains enabled, provide/test iPad screenshots and verify iPad UI.
- [ ] Metadata avoids prices, unsupported claims, Android references, or terms implying Kids Category.
- [ ] Copyright/legal entity matches Loch Lomond Travel rights.

## Age Rating

- [ ] Complete App Store Connect age rating honestly.
- [ ] Account for unrestricted web access if web links/browser content are accessible.
- [ ] Account for user-generated chat/photos.
- [ ] Account for emergency/safety content only if it fits a descriptor.
- [ ] Do not choose Kids Category.
- [ ] If minors can be passengers, make privacy policy and moderation suitable for children’s data without marketing the app as for children.

## Business Model, Payments, And External Links

- [ ] Confirm the app has no paid digital content, subscriptions, unlocks, IAP, ads, or paid account creation.
- [ ] If any paid digital feature is added, use StoreKit/In-App Purchase unless a documented Apple exception applies.
- [ ] Do not direct users to outside purchase mechanisms for digital goods.
- [ ] External links to travel booking/support are acceptable only if not selling digital in-app content that should use IAP.
- [ ] If Apple Pay is added for physical travel services, disclose material purchase and cancellation information before payment.

## Export Compliance

- [ ] Keep `ios.config.usesNonExemptEncryption` accurate.
- [ ] Current config says `false`; verify this remains true for standard HTTPS/Firebase/OS crypto only.
- [ ] Answer App Store Connect export compliance questions consistently.
- [ ] If custom/proprietary crypto, VPN, secure messaging beyond normal transport, or encryption export-sensitive features are added, reassess.

## Build, Binary, And Expo/EAS

- [ ] Run a production EAS iOS build.
- [ ] Confirm `expo-dev-client`, dev launcher, Bonjour/local network metadata, and Android overlay permissions are stripped in production.
- [ ] Confirm production `NSAppTransportSecurity` disallows arbitrary loads.
- [ ] Confirm all production environment variables are real and not placeholders.
- [ ] Confirm `runtimeVersion` and Expo Updates channel are correct for production.
- [ ] Do not ship OTA updates that materially change reviewed functionality without a new binary review.
- [ ] Increment build number for every upload.
- [ ] Verify app icon, splash, and launch screen on device.
- [ ] Verify binary size and app launch performance.
- [ ] Verify IPv6-only network compatibility where possible.
- [ ] Verify no private APIs, hidden features, debug menus, internal admin-only tools, or test banners in production.

## Functional Test Matrix

- [ ] `npm test`
- [ ] `npm run test:mobile`
- [ ] `npm run test:all:with-emulators`
- [ ] Production build installs and launches on physical iPhone.
- [ ] Production build installs and launches on physical iPad or tablet support is disabled.
- [ ] Passenger login: valid reference/email.
- [ ] Passenger login: invalid reference/email.
- [ ] Passenger login: offline cached identity.
- [ ] Driver login: valid `D-` code.
- [ ] Driver login: invalid `D-` code.
- [ ] Tour home loads live backend data.
- [ ] Itinerary loads and works offline after sync.
- [ ] Passenger map works with location allowed.
- [ ] Passenger map degrades gracefully with location denied.
- [ ] Driver pickup-location sharing works with location allowed.
- [ ] Driver pickup-location sharing degrades with location denied.
- [ ] Chat send/retry/delete/reaction paths work.
- [ ] Chat/photo moderation/report/block paths work once implemented.
- [ ] Group photo upload via camera works.
- [ ] Group photo upload via library works.
- [ ] Private photo upload/delete works.
- [ ] Photo upload works with limited photo library access.
- [ ] Notification onboarding can be completed or skipped.
- [ ] Notification preferences save with permission granted.
- [ ] Notification preferences save with permission denied.
- [ ] Push token registration succeeds on physical device.
- [ ] Test notification works.
- [ ] Safety report works with and without included location.
- [ ] SOS opens emergency options and does not auto-call.
- [ ] Account & privacy opens privacy policy and support email.
- [ ] Delete account completes and returns user to sign-in/replacement auth as expected.
- [ ] App remains usable after account deletion.
- [ ] Crash/diagnostic logging does not expose raw credentials, emails, tokens, or exact sensitive coordinates.
- [ ] Large Text / Dynamic Type does not break key screens.
- [ ] VoiceOver can complete login, tour home navigation, settings/privacy, and primary flows if claiming VoiceOver support.
- [ ] Low network and backend timeout paths show useful errors, not crashes.

## App Store Connect Fields

- [ ] Primary language.
- [ ] Category and optional secondary category.
- [ ] Pricing and availability.
- [ ] Age rating.
- [ ] App privacy responses.
- [ ] Privacy policy URL.
- [ ] Support URL.
- [ ] Marketing URL if used.
- [ ] Description.
- [ ] Keywords.
- [ ] Promotional text if used.
- [ ] Release notes.
- [ ] Screenshots for all required/supported device families.
- [ ] App Review contact first name, last name, phone, email.
- [ ] Demo credentials and review notes.
- [ ] Export compliance.
- [ ] Content rights.
- [ ] Advertising identifier: No, unless IDFA/tracking is added.
- [ ] Accessibility Nutrition Labels: optional currently, but if answered, audit before claiming support.

## Release Readiness Sign-Off

- [ ] All blockers are closed.
- [ ] Privacy policy has legal/business approval.
- [ ] App Privacy Label has technical sign-off from dependency/privacy audit.
- [ ] Review credentials have been tested on the exact production/TestFlight build.
- [ ] Backend seed data is locked for at least two review weeks.
- [ ] Production build has been tested by internal TestFlight users.
- [ ] External TestFlight review has passed if using external testers.
- [ ] First App Store submission notes are specific and complete.
- [ ] A rollback/support plan exists for launch day.

