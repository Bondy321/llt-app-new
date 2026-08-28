'use strict';

process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: 'demo-llt-architecture',
  storageBucket: 'demo-bucket.appspot.com',
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createArchitectureReport } = require('../../scripts/reportArchitecture');
const { isOpaquePassengerId } = require('../../functions/lib/passengerIdentity');
const { createAppSessionId, isValidAppSessionId } = require('../../functions/lib/appSession');

const repositoryRoot = path.resolve(__dirname, '../..');
const readJavaScriptTree = (directory) => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readJavaScriptTree(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fs.readFileSync(entryPath, 'utf8')] : [];
  })
  .join('\n');
const EXPECTED_FUNCTION_EXPORTS = [
  '__testables',
  'assignDriverToTour',
  'cleanupDriverLoginPolicySessions',
  'cleanupExpiredAppSessions',
  'cleanupExpiredChatStatusSessions',
  'cleanupExpiredDriverLocations',
  'cleanupExpiredDriverTourPacks',
  'cleanupExpiredLoginRateLimits',
  'cleanupNotificationDeliveryData',
  'cleanupNotificationReadState',
  'createGroupPhotoChatMessage',
  'createManualPassengerBooking',
  'createServerTestNotification',
  'deleteGroupPhoto',
  'deletePrivatePhoto',
  'deleteTourData',
  'endAppSession',
  'generatePhotoVariants',
  'getDriverLoginPolicy',
  'getMarketingNotificationDetail',
  'getSafetyAlertDetail',
  'getTourManifest',
  'ingestDriverTourPacks',
  'normalizeTourDateIndexes',
  'normalizeTourEndDateIndex',
  'previewNotificationAudience',
  'processBroadcastWrite',
  'processCategoryBroadcastWrite',
  'processNotificationDeliveryJob',
  'processNotificationReadMigrationRequest',
  'processNotificationReceipts',
  'projectChatPresenceSession',
  'projectChatTypingSession',
  'projectDriverLocationPickup',
  'projectDriverLocationSession',
  'projectDriverTourPackActionState',
  'reconcilePassengerRoleClaims',
  'recoverNotificationDeliveryJobs',
  'removeReportedPhoto',
  'requeueNotificationJob',
  'resolveGroupPhotoMedia',
  'resolvePrivatePhotoMedia',
  'revokeAppSession',
  'sendChatNotification',
  'sendDriverTourPackChangeNotification',
  'sendInternalChatNotification',
  'sendItineraryNotification',
  'sendSafetyAlertNotification',
  'setDriverLoginPolicy',
  'submitSafetyReport',
  'updateNotificationDeviceRegistration',
  'uploadGroupPhoto',
  'uploadPrivatePhoto',
  'verifyDriverLogin',
  'verifyPassengerLogin',
].sort();
const EXPECTED_MOBILE_ROUTES = [
  'AccountPrivacy',
  'Chat',
  'DriverHome',
  'DriverItinerary',
  'DriverTourPack',
  'GroupPhotobook',
  'Itinerary',
  'Login',
  'Map',
  'MarketingNotificationDetail',
  'NotificationPreferences',
  'PassengerManifest',
  'Photobook',
  'SafetyAlertDetail',
  'SafetySupport',
  'TourHome',
].sort();
const EXPECTED_SERVICE_EXPORTS = {
  'services/chatService.js': [
    'addReaction', 'deleteMessage', 'getChatMessageById', 'getChatMessages', 'getChatMessagesPage',
    'getMessageTextForCopy', 'hydrateGroupPhotoMessages', 'markChatAsRead', 'markInternalChatAsRead',
    'removeReaction', 'sendImageMessage', 'sendInternalDriverMessage', 'sendInternalMessageDirect',
    'sendMessage', 'sendMessageDirect', 'setOnlinePresence', 'setTypingStatus', 'subscribeToChatMessages',
    'subscribeToInternalDriverChat', 'subscribeToPresence', 'subscribeToReadReceipts',
    'subscribeToTypingIndicators', 'toggleReaction',
  ].sort(),
  'services/bookingServiceRealtime.js': [
    'MANIFEST_STATUS', 'applyManifestUpdateDirect', 'assignDriverToTour', 'buildAssignedDriverCodePayload',
    'ensureBookingSchemaConsistency', 'ensureTourParticipantCount', 'getDriverItinerary', 'getTourItinerary',
    'getTourManifest', 'joinTour', 'normalizeManifestPassengerRows', 'resolveVerifiedPassengerIdentity',
    'updateManifestBooking', 'validateBookingReference',
  ].sort(),
  'services/photoService.js': [
    'buildGroupPhotoAuthHeaders', 'buildGroupPhotoEndpointUrl', 'buildPrivatePhotoEndpointUrl', 'createBlob',
    'deleteGroupPhoto', 'deletePrivatePhoto', 'fetchPrivatePhotosPage', 'fetchTourPhotosPage',
    'resolveGroupPhotoMedia', 'resolvePrivatePhotoMedia', 'subscribeToPrivatePhotos', 'subscribeToTourPhotos',
    'updatePhotoCaption', 'uploadPhoto', 'uploadPhotoDirect',
  ].sort(),
};

const EVENT_PATHS = {
  processBroadcastWrite: 'broadcasts/{tourId}/{broadcastId}',
  processCategoryBroadcastWrite: 'category_broadcasts/{categoryKey}/{broadcastId}',
  processNotificationReadMigrationRequest: 'notification_read_migration_requests/{tourId}/{authUid}',
  processNotificationDeliveryJob: 'notification_job_fanout_queue/{queueKey}',
  projectChatPresenceSession: 'chat_presence_sessions/{scope}/{appSessionId}',
  projectChatTypingSession: 'chat_typing_sessions/{scope}/{appSessionId}',
  projectDriverLocationPickup: 'driver_location_pickups/{tourId}',
  projectDriverLocationSession: 'driver_location_sessions/{sourceKey}',
  projectDriverTourPackActionState: 'driver_tour_pack_actions/{departureKey}/{driverId}',
  sendChatNotification: 'chats/{tourId}/messages/{messageId}',
  sendDriverTourPackChangeNotification: 'driver_tour_packs/{departureKey}',
  sendInternalChatNotification: 'internal_chats/{tourId}/messages/{messageId}',
  sendItineraryNotification: 'tours/{tourId}/itinerary',
  sendSafetyAlertNotification: 'tours/{tourId}/safetyAlerts/{eventId}',
  normalizeTourDateIndexes: 'tours/{tourId}/startDate',
  normalizeTourEndDateIndex: 'tours/{tourId}/endDate',
};
const SCHEDULES = {
  cleanupDriverLoginPolicySessions: 'every 15 minutes',
  cleanupExpiredChatStatusSessions: 'every 15 minutes',
  cleanupExpiredAppSessions: 'every 15 minutes',
  cleanupExpiredDriverLocations: 'every 15 minutes',
  cleanupExpiredDriverTourPacks: 'every 6 hours',
  cleanupExpiredLoginRateLimits: 'every 1 hours',
  cleanupNotificationReadState: 'every 15 minutes',
  processNotificationReceipts: 'every 15 minutes',
  reconcilePassengerRoleClaims: 'every 15 minutes',
  recoverNotificationDeliveryJobs: 'every 5 minutes',
  cleanupNotificationDeliveryData: 'every 24 hours',
};
const HTTP_FUNCTIONS = EXPECTED_FUNCTION_EXPORTS.filter((name) => (
  name !== '__testables'
  && name !== 'generatePhotoVariants'
  && !Object.hasOwn(EVENT_PATHS, name)
  && !Object.hasOwn(SCHEDULES, name)
));

const normalizeEndpoint = (handler) => {
  const endpoint = handler?.__endpoint || {};
  return {
    platform: endpoint.platform,
    region: endpoint.region,
    maxInstances: endpoint.maxInstances ?? null,
    memory: Number.isFinite(endpoint.availableMemoryMb) ? endpoint.availableMemoryMb : null,
    timeout: endpoint.timeoutSeconds ?? null,
    concurrency: endpoint.concurrency ?? null,
    type: endpoint.httpsTrigger ? 'https'
      : endpoint.scheduleTrigger ? 'schedule'
        : endpoint.eventTrigger?.eventType === 'google.cloud.storage.object.v1.finalized' ? 'storage-finalized'
          : endpoint.eventTrigger?.eventType || null,
    path: endpoint.eventTrigger?.eventFilterPathPatterns?.ref || null,
    schedule: endpoint.scheduleTrigger?.schedule || null,
    timeZone: endpoint.scheduleTrigger?.timeZone || null,
    retry: endpoint.eventTrigger?.retry ?? null,
  };
};

test('Firebase Function exports retain their complete public names', () => {
  const functions = require('../../functions');
  assert.deepEqual(Object.keys(functions).sort(), EXPECTED_FUNCTION_EXPORTS);
});

test('major mobile compatibility services retain their complete public APIs', () => {
  const report = createArchitectureReport();
  assert.deepEqual(report.serviceExports, EXPECTED_SERVICE_EXPORTS);
});

test('mobile route names remain stable', () => {
  assert.deepEqual(createArchitectureReport().mobileRoutes, EXPECTED_MOBILE_ROUTES);
});

test('Function trigger type, path, schedule, region, and resource settings remain stable', () => {
  const functions = require('../../functions');
  const endpoints = Object.fromEntries(EXPECTED_FUNCTION_EXPORTS
    .filter((name) => name !== '__testables')
    .map((name) => [name, normalizeEndpoint(functions[name])]));

  for (const name of HTTP_FUNCTIONS) assert.equal(endpoints[name].type, 'https', name);
  for (const [name, refPath] of Object.entries(EVENT_PATHS)) {
    assert.match(endpoints[name].type, /^google\.firebase\.database\.ref\.v1\./u, name);
    assert.equal(endpoints[name].path, refPath, name);
  }
  for (const [name, schedule] of Object.entries(SCHEDULES)) {
    assert.equal(endpoints[name].type, 'schedule', name);
    assert.equal(endpoints[name].schedule, schedule, name);
    assert.equal(endpoints[name].timeZone, 'Europe/London', name);
  }
  assert.equal(endpoints.generatePhotoVariants.type, 'storage-finalized');
  assert.deepEqual(endpoints.generatePhotoVariants.region, ['us-east1']);
  for (const [name, endpoint] of Object.entries(endpoints)) {
    if (name !== 'generatePhotoVariants') assert.deepEqual(endpoint.region, ['europe-west1'], name);
  }
  assert.equal(endpoints.processNotificationReadMigrationRequest.retry, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(endpoints).filter(([, value]) => value.memory !== null).map(([name, value]) => [name, value.memory])),
    {
      cleanupDriverLoginPolicySessions: 256,
      cleanupExpiredChatStatusSessions: 256,
      cleanupExpiredAppSessions: 256,
      cleanupExpiredDriverLocations: 256,
      cleanupExpiredDriverTourPacks: 256,
      cleanupExpiredLoginRateLimits: 256,
      cleanupNotificationReadState: 256,
      ingestDriverTourPacks: 512,
      uploadGroupPhoto: 512,
      uploadPrivatePhoto: 512,
    },
  );
  assert.equal(endpoints.ingestDriverTourPacks.concurrency, 4);
  assert.equal(endpoints.deleteTourData.timeout, 300);
  assert.equal(endpoints.removeReportedPhoto.timeout, 120);
});

test('opaque passenger, app-session, and media identity formats reject credential-shaped values', () => {
  assert.equal(isOpaquePassengerId('pax_v2_0123456789abcdef0123456789abcdef'), true);
  assert.equal(isOpaquePassengerId('pax_v1:BOOKING:passenger@example.com'), false);
  assert.equal(isOpaquePassengerId('pax_v2_BOOKINGpassenger@example.com'), false);
  const sessionId = createAppSessionId();
  assert.match(sessionId, /^sess_v1_[a-f0-9]{32}$/u);
  assert.equal(isValidAppSessionId(sessionId), true);
  assert.equal(isValidAppSessionId('sess_v1_booking@example.com'), false);

  const functions = require('../../functions');
  const photoKey = functions.__testables.toRealtimeKeySegment('photo_job.v2:retry/1');
  assert.ok(photoKey.length > 0 && photoKey.length <= 240);
  assert.doesNotMatch(photoKey, /[.#$\/\[\]\u0000-\u001F\u007F]/u);
});

test('high-value HTTP reason codes remain represented at the backend boundary', () => {
  const source = [
    fs.readFileSync(path.join(repositoryRoot, 'functions/index.js'), 'utf8'),
    readJavaScriptTree(path.join(repositoryRoot, 'functions/src')),
  ].join('\n');
  const expectedReasonCodes = [
    'APP_CHECK_REQUIRED', 'ASSIGNMENT_IN_PROGRESS', 'DELETE_IN_PROGRESS', 'DRIVER_ALREADY_LINKED',
    'DRIVER_NOT_FOUND', 'ENDED', 'EVENT_ID_CONFLICT', 'IDENTITY_INCOMPLETE', 'IDEMPOTENCY_CONFLICT',
    'INTERNAL_ERROR', 'INVALID_CREDENTIALS', 'INVALID_IMAGE', 'INVALID_INPUT', 'INVALID_REPORT',
    'METHOD_NOT_ALLOWED', 'NOT_AUTHENTICATED', 'NOT_AUTHORIZED', 'NOT_FOUND', 'NOT_OWNER',
    'ORIGIN_NOT_ALLOWED', 'PHOTO_NOT_FOUND', 'ROLE_TRANSITION_IN_PROGRESS', 'SERVICE_UNAVAILABLE', 'SESSION_CHANGED',
    'SESSION_IN_PROGRESS', 'SUBMISSION_IN_PROGRESS', 'TOUR_ALREADY_ASSIGNED', 'TOUR_INACTIVE',
    'TOUR_NOT_FOUND', 'TRY_AGAIN_LATER', 'UNSUPPORTED_CONTENT',
  ];
  for (const code of expectedReasonCodes) assert.match(source, new RegExp(`['\"]${code}['\"]`, 'u'), code);
});
