'use strict';

const sessionTour = "root.child('app_sessions/' + auth.uid + '/tourId').val()";
const sourcePassengerRuleBoundaries = Object.freeze([
  ['passenger_trip_signals/v1/bookings/$bookingRef', '.read', sessionTour],
  ['passenger_trip_signals/v1/tours/$tourId', '.read', '$tourId'],
  ['tour_manifests/$tourId/bookings/$bookingRef', '.read', '$tourId'],
  ['tour_manifests/$tourId/bookings/$bookingRef', '.write', '$tourId'],
  ['tours/$tourId/driverLocation', '.read', '$tourId'],
  ['tours/$tourId/participants/$userId', '.read', '$tourId'],
  ['tours/$tourId/itinerary', '.read', '$tourId'],
  ['tours/$tourId/liveTracking/$userId', '.read', '$tourId'],
  ['tours/$tourId/liveTracking/$userId', '.write', '$tourId'],
  ['chats/$tourId', '.read', '$tourId'],
  ['chats/$tourId/messages/$messageId', '.write', '$tourId'],
  ['chats/$tourId/messages/$messageId/reactions/$emoji/$id', '.write', '$tourId'],
  ['chats/$tourId/lastRead/$principalId', '.write', '$tourId'],
  ['chats/$tourId/typing/$id', '.write', '$tourId'],
  ['chats/$tourId/presence/$id', '.write', '$tourId'],
  ['chat_presence_sessions/$scope/$appSessionId', '.write', sessionTour],
  ['chat_typing_sessions/$scope/$appSessionId', '.write', sessionTour],
  ['group_tour_photos/$tourId', '.read', '$tourId'],
  ['group_tour_photos/$tourId/$photoId/caption', '.write', '$tourId'],
  ['group_tour_photos/$tourId/$photoId/captionUpdatedAt', '.write', '$tourId'],
  ['group_tour_photos/$tourId/$photoId/captionEditedBy', '.write', '$tourId'],
  ['private_tour_photos/$tourId/$ownerId', '.read', '$tourId'],
  ['private_tour_photos/$tourId/$ownerId/$photoId/caption', '.write', '$tourId'],
  ['private_tour_photos/$tourId/$ownerId/$photoId/captionUpdatedAt', '.write', '$tourId'],
  ['private_tour_photos/$tourId/$ownerId/$photoId/captionEditedBy', '.write', '$tourId'],
  ['content_reports/$reportId', '.read', "data.child('tourId').val()"],
  ['content_reports/$reportId', '.write', "newData.child('tourId').val()"],
  ['broadcasts/$tourId', '.read', '$tourId'],
  ['tour_notifications/$tourId', '.read', '$tourId'],
  ['notification_read_state/$tourId/$principalId', '.read', '$tourId'],
  ['notification_read_state/$tourId/$principalId/$noticeId', '.write', '$tourId'],
  ['tour_access_grants/$tourId/$userId', '.read', '$tourId'],
  ['booking_access_grants/$bookingRef/$userId', '.read', "data.child('tourId').val()"],
  ['notification_read_migration_requests/$tourId/$authUid', '.write', '$tourId'],
]);

const sourcePassengerScopeGuard = tour => {
  const user = "root.child('users/' + auth.uid)";
  const session = "root.child('app_sessions/' + auth.uid)";
  const ref = `${user}.child('bookingRef')`;
  const booking = `root.child('bookings/' + ${ref}.val())`;
  // RTDB's regex lexer does not interpret escaped Unicode/hex control ranges
  // like Node. JSON-encoded literal control endpoints preserve the key bound.
  const controls = String.fromCharCode(0, 45, 31, 127);
  return `(${ref}.isString() && ${ref}.val().matches(/^[^.#$\\/\\[\\]${controls}]{1,160}$/)`
    + ` && ${user}.child('principalType').val() === 'passenger'`
    + ` && ${user}.child('stablePassengerId').val() === ${session}.child('principalId').val()`
    + ` && ${session}.child('principalType').val() === 'passenger'`
    + ` && ${session}.child('authUid').val() === auth.uid && ${session}.child('status').val() === 'active'`
    + ` && ${session}.child('expiresAtMs').val() > now && ${session}.child('tourId').val() === ${tour}`
    + ` && ${booking}.child('loginEligible').val() !== false`
    + ` && (!${booking}.child('sourceRoster').exists() || (`
    + `${booking}.child('tourId').isString() && ${booking}.child('tourId').val().length <= 100`
    + ` && ${booking}.child('tourId').val() === ${tour}`
    + ` && ${booking}.child('sourceRoster/schemaVersion').val() === 1`
    + ` && ${booking}.child('sourceRoster/state').val() === 'active')))`;
};
const constrainSourcePassengerRule = (rule, tour) => `(${rule}) && (`
  + "auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users/' + auth.uid).val() === true"
  + " || root.child('app_sessions/' + auth.uid + '/principalType').val() === 'driver'"
  + ` || ${sourcePassengerScopeGuard(tour)})`;

module.exports = { constrainSourcePassengerRule, sourcePassengerRuleBoundaries, sourcePassengerScopeGuard };
