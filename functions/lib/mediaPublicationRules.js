'use strict';

const mediaPublicationGate = () => {
  const op = "root.child('media_upload_operations').child(auth.uid).child(auth.mediaOperationId)";
  const session = "root.child('app_sessions').child(auth.uid)";
  const authority = "root.child('app_session_authority').child(auth.uid)";
  const tour = `root.child('tours').child(${op}.child('tourId').val())`;
  const lifecycle = `root.child('sync_roster_control').child(${op}.child('tourId').val()).child('lifecycle')`;
  const device = "root.child('driver_device_authorizations').child(auth.uid)";
  const driver = `root.child('drivers').child(${session}.child('driverId').val())`;
  const booking = `root.child('bookings').child(${op}.child('bookingRef').val())`;
  const security = `root.child('passenger_identity_security').child(${op}.child('bookingRef').val())`;
  const record = `root.child(${op}.child('recordPath').val())`;
  const next = `newData.child(${op}.child('recordPath').val())`;
  const nextOp = "newData.child('media_upload_operations').child(auth.uid).child(auth.mediaOperationId)";
  const staff = [
    `${device}.child('schemaVersion').val() === 1`,
    `${device}.child('generation').isString() && ${device}.child('generation').val().matches(/^[a-f0-9]{48}$/)`,
    `root.child('driver_staff_policy').child(${session}.child('driverId').val()).child('schemaVersion').val() === 1`,
    `${device}.child('state').val() === 'active'`,
    `${device}.child('sessionId').val() === ${session}.child('sessionId').val()`,
    `${device}.child('driverId').val() === ${session}.child('driverId').val()`,
    `${device}.child('generation').isString()`,
    `root.child('driver_staff_policy').child(${session}.child('driverId').val()).child('generation').val() === ${device}.child('generation').val()`,
    `root.child('driver_login_policy/v1/schemaVersion').val() === 1`,
    `root.child('driver_login_policy/v1/generation').val() === ${session}.child('driverLoginPolicyGeneration').val()`,
    `(root.child('driver_login_policy/v1/enforceSingleDevice').val() === false || (root.child('driver_login_policy/v1/enforceSingleDevice').val() === true && ${driver}.child('authUid').val() === auth.uid && ${driver}.child('authUidStaffGeneration').val() === ${device}.child('generation').val()))`,
    `${driver}.child('currentTourId').val() === ${op}.child('tourId').val()`,
    `root.child('tour_manifests').child(${op}.child('tourId').val()).child('assigned_drivers').child(${session}.child('driverId').val()).val() === true`,
    `!root.child('driver_assignment_active/v1').child(${session}.child('driverId').val()).exists()`,
    `(!root.child('driver_login_policy/v1').child('transitionPhase').exists() || root.child('driver_login_policy/v1').child('transitionPhase').val() === 'stable')`,
  ].join(' && ');
  const passenger = [
    `!root.child('account_deletion_passenger_active/v1').child(${op}.child('passengerDeletionKey').val()).exists()`,
    `${security}.child('deviceAuthorizationVersion').val() === 2`,
    `${security}.child('authorizedAuthUids').child(auth.uid).val() === true`,
    `${security}.child('passengerPrincipalId').val() === ${op}.child('principalId').val()`,
    `${tour}.child('participants').child(auth.uid).child('schemaVersion').val() === 2`,
    `${tour}.child('participants').child(auth.uid).child('principalId').val() === ${op}.child('principalId').val()`,
    `${tour}.child('participants').child(auth.uid).child('sessionId').val() === ${session}.child('sessionId').val()`,
    `${booking}.exists() && ${booking}.child('tourId').val() === ${op}.child('sourceTourId').val()`,
    `${booking}.child('loginEligible').val() !== false`,
    `(!${booking}.child('sourceRoster').exists() || ${booking}.child('sourceRoster/state').val() === 'active')`,
  ].join(' && ');
  const currentSession = [
    `${authority}.child('schemaVersion').val() === 1`,
    `${authority}.child('epoch').isString() && ${authority}.child('epoch').val().matches(/^[a-f0-9]{48}$/)`,
    `${session}.child('schemaVersion').val() === 1 && ${session}.child('authUid').val() === auth.uid`,
    `${authority}.child('state').val() === 'committed'`,
    `${authority}.child('epoch').val() === ${op}.child('authorityEpoch').val()`,
    `${authority}.child('sessionId').val() === ${op}.child('sessionId').val()`,
    `${session}.child('status').val() === 'active' && ${session}.child('expiresAtMs').val() > now`,
    `${session}.child('sessionId').val() === ${op}.child('sessionId').val()`,
    `${session}.child('sessionRevision').val() === ${op}.child('sessionRevision').val()`,
    `${session}.child('principalId').val() === ${op}.child('principalId').val()`,
    `${session}.child('tourId').val() === ${op}.child('tourId').val()`,
    `((${session}.child('principalType').val() === 'driver' && (${staff})) || (${session}.child('principalType').val() === 'passenger' && (${passenger})))`,
  ].join(' && ');
  const admin = `${op}.child('role').val() === 'admin' && ${op}.child('adminMfa').val() === true && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users').child(auth.uid).val() === true)`;
  return [
    'auth != null && auth.lltMediaPublisher === true',
    `${op}.child('schemaVersion').val() === 1 && ${op}.child('authUid').val() === auth.uid`,
    `${op}.child('expiresAtMs').val() > now`,
    `${tour}.exists() && ${lifecycle}.child('state').val() !== 'deleting' && ${lifecycle}.child('state').val() !== 'deleted'`,
    `${lifecycle}.child('generation').val() === ${op}.child('tourGeneration').val()`,
    `root.child(${op}.child('lockPath').val()).child('owner').val() === auth.mediaLockOwner`,
    `root.child(${op}.child('lockPath').val()).child('expiresAtMs').val() > now`,
    `(${admin} || (${currentSession}))`,
    `!${record}.child('_serverDeletion').exists()`,
    `${next}.child('_upload/operationId').val() === auth.mediaOperationId`,
    `${next}.child('_upload/authUid').val() === auth.uid`,
    `${next}.child('userId').val() === ${op}.child('principalId').val()`,
    `${next}.child('storagePath').val() === ${op}.child('storagePath').val()`,
    `((auth.mediaPhase === 'reserve' && ${op}.child('state').val() === 'pending' && !${record}.exists() && ${next}.child('_upload/status').val() === 'pending' && ${nextOp}.child('state').val() === 'reserved') || (auth.mediaPhase === 'finalize' && ${op}.child('state').val() === 'reserved' && ${record}.child('_upload/operationId').val() === auth.mediaOperationId && ${record}.child('_upload/status').val() === 'pending' && ${next}.child('_upload/status').val() === 'complete' && ${nextOp}.child('state').val() === 'committed'))`,
  ].join(' && ');
};

const applyMediaPublicationRules = document => {
  const rules = document.rules;
  if (rules.media_upload_operations) throw new Error('Media publication rules already installed');
  const visit = node => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '.write') node[key] = `(auth == null || auth.lltMediaPublisher !== true) && (${value})`;
      else if (key === '.validate') node[key] = `(auth != null && auth.lltMediaPublisher === true) || (${value})`;
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(rules);
  rules['.validate'] = `(auth != null && auth.lltMediaPublisher === true) ? (${mediaPublicationGate()}) : (${rules['.validate']})`;
  const grant = (node, path) => {
    node['.write'] = `(${node['.write'] || false}) || (auth != null && auth.lltMediaPublisher === true && root.child('media_upload_operations').child(auth.uid).child(auth.mediaOperationId).child('recordPath').val() === ${path})`;
  };
  grant(rules.group_tour_photos.$tourId.$photoId, "'group_tour_photos/' + $tourId + '/' + $photoId");
  grant(rules.private_tour_photos.$tourId.$ownerId.$photoId, "'private_tour_photos/' + $tourId + '/' + $ownerId + '/' + $photoId");
  rules.media_upload_operations = { '.read': false, '.write': false, $uid: { '.indexOn': ['dueAtMs'], $operationId: {
    state: { '.write': "auth != null && auth.lltMediaPublisher === true && auth.uid === $uid && auth.mediaOperationId === $operationId && (newData.val() === 'reserved' || newData.val() === 'committed')" },
  } } };
  rules.media_upload_cleanup_queue = { '.read': false, '.write': false, '.indexOn': ['dueAtMs'], $operationId: {
    '.write': "auth != null && auth.lltMediaPublisher === true && auth.mediaPhase === 'finalize' && auth.mediaOperationId === $operationId && !newData.exists()",
  } };
  return document;
};

const mediaChatPublicationGate = () => {
  const photo = "root.child('group_tour_photos').child(auth.mediaTourId).child(auth.mediaPhotoId)";
  const lifecycle = "root.child('sync_roster_control').child(auth.mediaTourId).child('lifecycle')";
  return [
    "auth.mediaExpiresAtMs > now",
    "root.child('tours').child(auth.mediaTourId).exists()",
    `${lifecycle}.child('generation').val() === auth.mediaTourGeneration`,
    `${lifecycle}.child('state').val() !== 'deleting' && ${lifecycle}.child('state').val() !== 'deleted'`,
    `${photo}.exists() && !${photo}.child('_serverDeletion').exists()`,
    `${photo}.child('_upload/status').val() !== 'pending' && ${photo}.child('_upload/status').val() !== 'cancelled'`,
    `${photo}.child('storagePath').val() === auth.mediaStoragePath`,
    `${photo}.child('userId').val() === auth.mediaPhotoOwner`,
    `${photo}.child('_upload/operationId').val() === auth.mediaUploadOperationId`,
    "((auth.mediaAdmin === true && auth.token.firebase.sign_in_second_factor === 'totp' && (auth.uid === '9CWQ4705gVRkfW5Xki5LyvrmVp23' || root.child('admin_users').child(auth.uid).val() === true)) || (root.child('app_session_authority').child(auth.uid).child('state').val() === 'committed' && root.child('app_session_authority').child(auth.uid).child('epoch').val() === auth.mediaAuthorityEpoch && root.child('app_sessions').child(auth.uid).child('sessionId').val() === auth.mediaSessionId && root.child('app_sessions').child(auth.uid).child('sessionRevision').val() === auth.mediaSessionRevision && root.child('app_sessions').child(auth.uid).child('tourId').val() === auth.mediaTourId))",
    "(auth.mediaPassengerDeletionKey === null || !root.child('account_deletion_passenger_active/v1').child(auth.mediaPassengerDeletionKey).exists())",
  ].join(' && ');
};
const applyMediaChatPublicationRules = document => {
  const rules = document.rules;
  if (String(rules['.validate']).includes('auth.lltMediaChatWriter')) throw new Error('Media chat gate already installed');
  rules['.validate'] = `(${rules['.validate']}) && (auth == null || auth.lltMediaChatWriter !== true || (${mediaChatPublicationGate()}))`;
  return document;
};

module.exports = { mediaPublicationGate, applyMediaPublicationRules, mediaChatPublicationGate, applyMediaChatPublicationRules };
