# Notification delivery contract

This matrix is authoritative for user-facing wording, producer payloads and delivery policy. All
production classes begin as deterministic server-owned jobs. `ticket_accepted` means Expo accepted a
message; `provider_accepted` means a later Expo receipt was successful. Neither status proves the
operating system displayed the notification.

| Class | Source and deterministic source ID | Audience and active session | Preference / sender | Lock-screen policy | Channel / priority | Expiry, collapse and grouping | Tap route and fallback | Job ID, retry and final state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tour announcement | `broadcasts/{tourId}/{broadcastId}` / `tour_announcement:{tourId}:{broadcastId}` | Current tour passengers and assigned drivers; active app session required | `ops.driver_updates`; sender excluded | Admin title and bounded announcement preview; no booking/customer data | `llt_tour_updates_v2`, default | Admin expiry or 24h; no collapse; tag/thread by tour | `Chat` with `tourId`, deterministic announcement `messageId`, `noticeId`; durable tour notice | `notif_v1(sha256(source))`; temporary request/receipt retry; provider outcomes or `partial`, `no_recipients`, `expired` |
| Passenger group chat | `chats/{tourId}/messages/{messageId}` / `group_chat:{tourId}:{messageId}` | Current tour passengers and assigned drivers; active app session required | `ops.group_chat`; sender and duplicate token excluded | Sender name plus bounded text; no credentials | `llt_group_chat_v2`, default | 6h; distinct messages never collapse; tag/thread by tour | `Chat` with exact `tourId`, `messageId`, optional `noticeId`; in-app chat is fallback | Deterministic source hash; temporary retry; provider outcomes/partial/no recipients/expired |
| Group photo | Secure schema-v2 image chat message / `group_photo:{tourId}:{messageId}:{photoId}` | Current tour passengers and assigned drivers; active app session required | `ops.group_photos`; sender and duplicate token excluded | “Shared a photo”; never contains or persists a media URL | `llt_group_photos_v2`, default | 6h; distinct photos never collapse; tag/thread by tour | `Chat` with exact message and `photoId`; chat/photo metadata fallback | Deterministic source hash; one upload/message creates at most one job; normal retry/final states |
| Internal driver chat | `internal_chats/{tourId}/messages/{messageId}` / `internal_driver_chat:{tourId}:{messageId}` | Other coherently assigned drivers; active app session required | `ops.driver_updates`; sender excluded | Driver sender plus bounded text | `llt_driver_operations_v2`, high | 4h; distinct messages; tag/thread by tour | `Chat` with `internalDriverChat=true`, exact tour/message; internal chat fallback | Deterministic source hash; normal retry/final states |
| Itinerary change | Semantic write to `tours/{tourId}/itinerary` / `itinerary:{tourId}:{semanticRevision}` | Current tour passengers and assigned drivers; active app session required | `ops.itinerary_changes`; no sender | Bounded summary only | `llt_tour_updates_v2`, default | 24h; latest semantic revision replaces older tour revision; tag/thread by tour | `Itinerary` with `tourId`, `noticeId`; durable tour notice | Deterministic revision job; superseded state is never sent; normal retry/final states |
| Driver Tour Pack change | Semantic published pack revision / `driver_tour_pack:{departureKey}:{revision}` | Coherently assigned driver installations; active app session required | `ops.driver_updates`; no sender | Bounded changed-section/acknowledgement summary; no passenger or contract/service content | `llt_driver_operations_v2`, high | 12h; latest departure revision replaces older; tag/thread by departure | `DriverTourPack` with `tourId`, `departureKey`, `revision`, bounded `changedSections`; pack remains fallback | Deterministic revision job; supersession plus normal retry/final states |
| Safety report | `tours/{tourId}/safetyAlerts/{eventId}` / `safety:{tourId}:{eventId}` | Currently assigned drivers require an active matching app session; authorised operations admins are an always-on escalation audience and do not require tour membership | Mandatory safety policy; bypasses optional routine preferences; reporter excluded | Category/severity only; never free-text incident content | `llt_safety_v2`, high | 2h; distinct incidents never collapse; event tag/thread | `SafetyAlertDetail` with exact `tourId`, `eventId`; authorised dashboard/detail fallback | Deterministic incident job; warning on no recipient/no ticket/provider reject/unresolved receipt |
| Critical safety or SOS | Same safety source / `critical_safety:{tourId}:{eventId}` | Currently assigned drivers require an active matching app session; authorised operations admins remain an always-on escalation audience | Mandatory safety policy; reporter excluded | Urgent generic copy only; never free text; no iOS critical-alert entitlement | `llt_safety_v2`, high | 30m; never collapse distinct incidents; event tag/thread | Exact `SafetyAlertDetail`; dashboard warning/acknowledgement fallback | Deterministic incident job; aggressive bounded retry and visible escalation on failure |
| Future-tour category broadcast | `category_broadcasts/{categoryKey}/{broadcastId}` / `future_tour:{categoryKey}:{broadcastId}` | Current notification installations explicitly opted into category; no active tour session required | `marketing.{categoryKey}` default false; sender not applicable | Bounded title and preview; full body stays in durable detail | `llt_future_tours_v2`, default | Admin expiry or 7d; broadcast tag/thread by category | `MarketingNotificationDetail` with `categoryKey`, `broadcastId`; server-owned detail record | Deterministic source hash; paged full audience; normal retry/final states |
| Local test notification | Explicit mobile “Local display test” action / local generated ID | Current device only; no server audience | No preference mutation | Fixed test copy | `default` for compatibility | Immediate/local only | Existing preferences screen | No server job, ticket or provider claim |
| Full server test notification | Admin authenticated current-device command / `server_test:{adminUid}:{requestId}` | Only authenticated operations admin’s registered current installation | Explicit test action; no preference bypass beyond target device | Fixed diagnostic copy without token data | `llt_driver_operations_v2`, high | 1h; no collapse | `NotificationPreferences` or admin test result | Dedicated deterministic job through normal ticket/receipt pipeline; final provider result shown |

## Job and attempt invariants

- Jobs are server-owned schema version 1 records and contain bounded presentation/navigation data,
  never raw Expo tokens, credentials, names used as identity, or incident free text.
- One source event maps to one deterministic job ID. Repeated Function delivery is idempotent.
- Leases, cursors, attempts, tickets, receipt state, subscriber indexes and retry metadata are
  client-write denied.
- Audience processing is paged until exhaustion. There is no recipient-count cap.
- Eligibility is evaluated at send time. Skip counts distinguish `no_token`, `permission_denied`,
  `permission_blocked`, `permission_unavailable`, `inactive_token`, `invalid_token`, `opted_out`,
  `inactive_operational_session`, `wrong_tour`, `duplicate_token`, `sender_excluded`, and
  `expired_job`.
- Ticket, receipt and job timestamps are epoch milliseconds. Retry delay is bounded exponential
  backoff. Provider receipt checks start approximately 15 minutes after ticket creation and expire
  after 24 hours.

## Retention

- Completed/no-recipient/expired jobs and attempts: 30 days.
- Provider ticket/receipt records: 30 days.
- Marketing detail records: through explicit expiry, then at most 30 additional days.
- Active/retrying jobs and unresolved receipts are not removed before their delivery/receipt windows
  end. Cleanup is scheduled and bounded.

## Endpoint authentication boundary

Device registration, marketing detail and safety detail endpoints require a current Firebase ID token
and enforce self, assignment or operations-admin authority on the server. App Check enforcement and
configuration are intentionally unchanged in this release because App Check is not currently enabled
for the app; enabling it requires a separate coordinated mobile/server rollout rather than a partial
notification-only change.

## Coordinated Expo enhanced-security procedure

1. Create the Expo access token in Secret Manager and deploy server support with the secret bound.
2. Run a full server-pipeline test and verify ticket plus receipt processing.
3. Enable enhanced push security in EAS.
4. Repeat the server-pipeline test.
5. If validation fails, disable enhanced security while retaining the server secret and investigate
   the visible `InvalidCredentials`/configuration warning. Never commit the token.
