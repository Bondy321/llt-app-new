# App Store Review Notes And Metadata

Last updated: 2026-06-10

## Privacy Policy URL

Use this URL in App Store Connect and keep it matched with the app fallback:

```text
https://lochlomondtravel.com/images/pdfs/Loch_Lomond_Travel_App_Privacy_Policy.pdf
```

The HTML source for the PDF is:

```text
docs/Loch_Lomond_Travel_App_Privacy_Policy.html
```

## Suggested App Review Notes

```text
LLT is a closed-access travel operations app for Loch Lomond Travel passengers and drivers.

Passenger demo:
Booking reference: provided in App Review credentials
Booking email: provided in App Review credentials

Driver demo:
Driver code: provided in App Review credentials

Suggested review path:
1. Log in as passenger to view Tour Home, Itinerary, Find My Bus, Group Chat, Photos, Notifications, Safety Support, and Account & privacy.
2. Long-press a group chat message to review reply/copy/reaction/report/mute actions. Open Group Album photo details to review report/delete actions where available.
3. Log out, then log in as driver with the D-code to review driver itinerary, passenger manifest, pickup-location sharing, internal chat, and safety tools.
4. Account deletion is under the account menu > Account & privacy > Delete account.

Notes:
- Public users need a valid booking reference/email or driver code because the app displays private tour operations data.
- The SOS screen opens emergency options and can open the phone dialer or SMS composer after user action. It does not contact emergency services automatically.
- Location is requested only for Find My Bus, meeting points/directions, driver pickup sharing, and optional safety/live-location features.
- Push notifications are optional and controlled in Notification Preferences.
- Camera/photo-library access is optional and used only for chat, group album, private photo upload, and saving tour photos to the device.
- User-generated chat/photo content can be reported to Loch Lomond Travel operations. Users can delete their own content where supported and can locally mute/hide reported chat/photo content.
```

## Product Page Metadata Draft

App name:

```text
LLT
```

Subtitle, 30 characters or fewer:

```text
Loch Lomond Travel tours
```

Category:

```text
Travel
```

Support URL:

```text
https://lochlomondtravel.com/
```

Marketing URL, if used:

```text
https://lochlomondtravel.com/
```

Description draft:

```text
LLT is the private Loch Lomond Travel companion app for passengers and drivers on supported tours.

Passengers can securely access their tour itinerary, pickup information, driver updates, group chat, shared tour photos, private photos, notifications, Find My Bus, and safety support.

Drivers can access assigned tour details, itinerary tools, passenger manifest information, pickup-location sharing, driver chat, and safety support.

The app requires a valid Loch Lomond Travel booking reference and booking email, or an authorised driver code. Public browsing is not available because the app displays private tour operations information.
```

Keywords draft, under 100 bytes:

```text
travel,tours,itinerary,coach,pickup,loch lomond
```

Age rating notes:

- Do not choose Kids Category.
- Account for user-generated chat/photos.
- Account for unrestricted external support/website links if App Store Connect asks.
- Safety/SOS content is operational support; it does not automatically contact emergency services.

Export compliance:

- Current Expo config sets `ios.config.usesNonExemptEncryption` to `false`.
- Answer consistently for standard HTTPS/Firebase/OS crypto only.
- Reassess if proprietary crypto, VPN, secure messaging beyond normal transport, or other export-sensitive encryption is added.
