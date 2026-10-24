'use strict';

const activeNotificationSessionGate = () => {
  const session = "root.child('app_sessions').child(auth.uid)";
  const mutation = "root.child('notification_mutation_authority').child(auth.uid)";
  const installation = "root.child('app_session_authority').child(auth.uid)";
  const device = "root.child('driver_device_authorizations').child(auth.uid)";
  const driverId = `${session}.child('driverId').val()`;
  const driver = `root.child('drivers').child(${driverId})`;
  const staff = `root.child('driver_staff_policy').child(${driverId})`;
  const policy = "root.child('driver_login_policy/v1')";
  const tourId = `${session}.child('tourId').val()`;
  const tour = `root.child('tours').child(${tourId})`;
  const bookingRef = `${mutation}.child('bookingRef').val()`;
  const booking = `root.child('bookings').child(${bookingRef})`;
  const security = `root.child('passenger_identity_security').child(${bookingRef})`;
  const participant = `${tour}.child('participants').child(auth.uid)`;
  const driverGate = [
    `${device}.child('schemaVersion').val() === 1 && ${device}.child('state').val() === 'active'`,
    `${device}.child('sessionId').val() === ${session}.child('sessionId').val()`,
    `${device}.child('driverId').val() === ${driverId}`,
    `${staff}.child('schemaVersion').val() === 1 && ${device}.child('generation').isString() && ${device}.child('generation').val().matches(/^[a-f0-9]{48}$/)`,
    `${staff}.child('generation').val() === ${device}.child('generation').val()`,
    `${policy}.child('schemaVersion').val() === 1 && ${session}.child('driverLoginPolicyGeneration').isNumber() && ${policy}.child('generation').val() === ${session}.child('driverLoginPolicyGeneration').val()`,
    `(${policy}.child('enforceSingleDevice').val() === false || (${policy}.child('enforceSingleDevice').val() === true && ${driver}.child('authUid').val() === auth.uid && ${driver}.child('authUidStaffGeneration').val() === ${device}.child('generation').val()))`,
    `!root.child('driver_assignment_active/v1').child(${driverId}).exists()`,
    `(!${policy}.child('transitionPhase').exists() || ${policy}.child('transitionPhase').val() === 'stable')`,
    `((${session}.child('tourId').exists() && ${driver}.child('currentTourId').val() === ${tourId} && ${tour}.exists() && root.child('tour_manifests').child(${tourId}).child('assigned_drivers').child(${driverId}).val() === true) || (!${session}.child('tourId').exists() && (!${driver}.child('currentTourId').exists() || (${driver}.child('currentTourId').isString() && ${driver}.child('currentTourId').val().matches(/^ *$/)))))`,
  ].join(' && ');
  const passengerGate = [
    `${mutation}.child('bookingRef').isString() && root.child('users').child(auth.uid).child('bookingRef').val() === ${bookingRef}`,
    `${security}.child('deviceAuthorizationVersion').val() === 2 && ${security}.child('authorizedAuthUids').child(auth.uid).val() === true && ${security}.child('loginLocked').val() !== true`,
    `${security}.child('passengerPrincipalId').val() === ${session}.child('principalId').val()`,
    `${participant}.child('schemaVersion').val() === 2 && ${participant}.child('sessionId').val() === ${session}.child('sessionId').val() && ${participant}.child('principalId').val() === ${session}.child('principalId').val()`,
    `${booking}.exists() && ${booking}.child('tourId').val() === ${mutation}.child('sourceTourId').val() && ${booking}.child('loginEligible').val() !== false`,
    `(!${booking}.child('sourceRoster').exists() || (${booking}.child('sourceRoster/schemaVersion').val() === 1 && ${booking}.child('sourceRoster/state').val() === 'active'))`,
    `${mutation}.child('passengerDeletionKey').isString() && !root.child('account_deletion_passenger_active/v1').child(${mutation}.child('passengerDeletionKey').val()).exists()`,
  ].join(' && ');
  return `${installation}.child('schemaVersion').val() === 1 && ${installation}.child('epoch').isString() && ${installation}.child('epoch').val().matches(/^[a-f0-9]{48}$/) && ((${session}.child('principalType').val() === 'driver' && (${driverGate})) || (${session}.child('principalType').val() === 'passenger' && (${passengerGate})))`;
};

const notificationPublicationGate = () => {
  const authority = "root.child('notification_mutation_authority').child(auth.uid)";
  const installation = "root.child('app_session_authority').child(auth.uid)";
  const session = "root.child('app_sessions').child(auth.uid)";
  const device = "root.child('notification_devices').child(auth.uid)";
  const tombstone = "root.child('notification_device_tombstones').child(auth.uid)";
  return [
    'auth != null && auth.lltNotificationIssuer === true',
    `${authority}.child('state').val() === 'prepared'`,
    `${authority}.child('epoch').val() === auth.notificationEpoch`,
    `${authority}.child('operationId').val() === auth.notificationOperationId`,
    `${authority}.child('expiresAtMs').val() > now`,
    `${installation}.child('epoch').val() === ${authority}.child('sessionEpoch').val()`,
    `${tombstone}.child('permanent').val() !== true`,
    `(${device}.child('registrationRevision').val() === ${authority}.child('expectedRegistrationRevision').val() || (!${device}.child('registrationRevision').exists() && ${authority}.child('expectedRegistrationRevision').val() === 0))`,
    `(${tombstone}.child('registrationRevision').val() === ${authority}.child('expectedTombstoneRevision').val() || (!${tombstone}.child('registrationRevision').exists() && ${authority}.child('expectedTombstoneRevision').val() === 0))`,
    `((${authority}.child('sessionId').exists() && ${installation}.child('state').val() === 'committed' && ${installation}.child('sessionId').val() === ${authority}.child('sessionId').val() && ${session}.child('sessionId').val() === ${authority}.child('sessionId').val() && ${session}.child('status').val() === 'active' && ${session}.child('expiresAtMs').val() > now) || (!${authority}.child('sessionId').exists() && (${session}.child('status').val() !== 'active' || ${session}.child('expiresAtMs').val() <= now) && ${installation}.child('state').val() !== 'prepared' && ${installation}.child('state').val() !== 'deletion_prepared' && ${installation}.child('state').val() !== 'deleted'))`,
    `(!${authority}.child('sessionId').exists() || (${activeNotificationSessionGate()}))`,
    `newData.child('notification_mutation_authority').child(auth.uid).child('state').val() === 'committed'`,
    `newData.child('notification_mutation_authority').child(auth.uid).child('epoch').val() === auth.notificationEpoch`,
  ].join(' && ');
};

const applyNotificationPublicationRules = document => {
  const rules = document.rules;
  if (rules.notification_mutation_authority) return document;
  const visit = node => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '.write') node[key] = `(auth == null || auth.lltNotificationIssuer !== true) && (${value})`;
      else if (key === '.validate') node[key] = `(auth != null && auth.lltNotificationIssuer === true) || (${value})`;
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(rules);
  // The bypass at descendant validators is safe only with the root's full
  // commit predicate and the exact server-captured path manifest below.
  rules['.validate'] = `(auth != null && auth.lltNotificationIssuer === true) ? (${notificationPublicationGate()}) : (${rules['.validate']})`;
  const grant = (node, path, uidVariable = '$authUid') => {
    const allowed = `auth != null && auth.lltNotificationIssuer === true && auth.uid === ${uidVariable} && root.child('notification_mutation_authority').child(auth.uid).child('writePaths')${path}.val() === true`;
    node['.write'] = `(${node['.write'] || false}) || (${allowed})`;
  };
  for (const name of ['notification_devices', 'notification_consents']) {
    rules[name] ||= {}; rules[name].$authUid ||= {};
    grant(rules[name].$authUid, `.child('${name}').child($authUid)`);
  }
  rules.notification_marketing_audience ||= {}; rules.notification_marketing_audience.v1 ||= {};
  rules.notification_marketing_audience.v1.$categoryKey ||= {};
  rules.notification_marketing_audience.v1.$categoryKey.$authUid ||= {};
  grant(rules.notification_marketing_audience.v1.$categoryKey.$authUid, ".child('notification_marketing_audience').child('v1').child($categoryKey).child($authUid)");
  rules.notification_mutation_authority = { '.read': false, '.write': false, $uid: {
    state: { '.write': "auth != null && auth.lltNotificationIssuer === true && auth.uid === $uid && newData.val() === 'committed'" },
  } };
  return document;
};

module.exports = { applyNotificationPublicationRules, notificationPublicationGate };
