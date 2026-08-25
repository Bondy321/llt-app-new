# Shared contracts

`contracts/definitions/contracts.v1.json` is the canonical data-only schema set. `contracts/fixtures/contracts.v1.json` contains valid and invalid examples. `contracts/types` contains declarations. `scripts/contracts/generateContracts.js` produces deployment-local adapters for mobile, Functions, and web admin so Functions never import runtime code outside their deployment package.

The schema set defines PassengerPrincipalId, DriverPrincipalId, AppSessionId, AppSession, PassengerParticipantRecord, PassengerLoginResponse, DriverLoginResponse, DriverAssignmentResponse, ChatMessage, ChatReaction, ChatPresenceRecord, GroupPhotoRecord, PrivatePhotoRecord, ResolvedMediaResponse, NotificationPayload, SafetySubmission, DriverLocationRecord, DriverTourPackActionResult, and StandardHttpErrorResponse.

Each contract records schema version, required/optional fields, enums, patterns, bounds, nullability, unknown-field policy, safe projection, and forbidden client fields. Fixtures reject credential-shaped identities, extra credential fields, malformed IDs/tours, mismatched drivers, durable media URLs, unknown session fields, invalid routes/schema versions, and unbounded text.

Change workflow:

1. Edit the canonical definition and fixtures.
2. Run `npm run contracts:generate`.
3. Update producer and consumer adapters.
4. Update Firebase rules when the duplicated rule shape changes.
5. Run `npm run contracts:check`; never hand-edit generated copies.
