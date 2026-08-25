/**
 * functions/index.js
 * Backend logic for Loch Lomond Travel App
 * Updated for Cloud Functions Gen 2 (v2) - Region Fix
 * Enhanced with comprehensive error handling, validation, and performance improvements
 */

const { onValueCreated, onValueWritten } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { randomUUID } = require("crypto");
const { admin } = require('./src/bootstrap/firebaseAdmin');
const {
  log,
  maskIdentifier,
  sanitizeLogData,
  sanitizeLogText,
} = require('./src/infrastructure/logging/safeLogger');
const {
  getExpoPushClient,
  isExpoPushToken,
} = require('./src/infrastructure/notifications/expoPushClient');
const { createPhotoVariantBuffers } = require('./src/infrastructure/storage/mediaProcessor');
const { isValidFirebaseKey } = require('./src/infrastructure/database/firebaseKey');
const {
  checkRateLimit,
  getRequestClientKey,
  hashRateLimitDimension,
} = require('./src/infrastructure/rate-limit/requestRateLimiter');
const {
  enforceLoginAppCheck,
  shouldRequireLoginAppCheck,
} = require('./src/infrastructure/auth/loginAppCheckGate');
const {
  checkPassengerLoginRateLimits,
  distributedLoginRateLimiter,
  getTrustedRequestNetworkKey,
} = require('./src/domains/passenger-auth/passengerLoginSecurity');
const { checkDriverLoginRateLimits } = require('./src/domains/driver-auth/driverLoginSecurity');
const { checkSafetySubmissionRateLimit } = require('./src/domains/safety/safetyRateLimit');
const { isDeployedFunctionsRuntime } = require('./src/config/runtimeConfig');
const { getBearerToken, verifyRequestAuthUid } = require('./src/infrastructure/auth/requestAuth');
const { authorizeAppSessionMobileRequest } = require('./src/infrastructure/auth/appSessionRequestAuth');
const { resolveSafetyReporterAccess } = require('./src/domains/safety/safetyAccess');
const {
  buildSafeAppSessionEvent,
  buildVerifiedLoginGrantUpdates,
  issueDriverAppSession,
  issuePassengerAppSession,
} = require('./src/domains/app-sessions/sessionIssuance');
const {
  buildPassengerSafeBooking,
  buildPassengerSafeItinerary,
  buildPassengerSafeTour,
} = require('./src/domains/passenger-auth/passengerProjection');
const {
  buildDriverManifestBooking,
  buildTourManifestPayload,
  normalizeManifestBooking,
  verifyTourManifestAccess,
} = require('./src/domains/manifests/manifestDomain');
const {
  buildDriverIdentityProfileUpdates,
  buildDriverSelfAssignmentUpdates,
  claimDriverAuthUid,
  collectDriverAssignmentConflicts,
  normalizeDriverId,
  resolveDriverAssignment,
} = require('./src/domains/driver-assignment/driverAssignment');
const { applyAuthenticatedCors, isAllowedAdminOrigin } = require('./src/infrastructure/http/adminCors');
const { verifyOperationsAdminAccess } = require('./src/domains/administration/adminAuthorization');
const { deleteStoragePaths, deleteStoragePrefixes } = require('./src/infrastructure/storage/storageDeletion');
const { acquireManualBookingLock, releaseManualBookingLock } = require('./src/infrastructure/database/operationLock');
const {
  buildTourDeletionUpdates,
  getBookingsForTour,
  resolveReportedPhotoStoragePaths,
} = require('./src/domains/administration/tourDeletion');
const {
  buildManualPassengerBookingUpdates,
  createManualPassengerError,
  findManualPassengerSeatConflicts,
  getBookingPassengerCount,
  getBookingSeatNumbers,
  mergePickupPoint,
  normalizeBookingRef,
  normalizeEmail,
  normalizeManualPassengerPayload,
  parseStrictDateOnly,
} = require('./src/domains/administration/manualPassengerBooking');
const {
  buildCanonicalSafetyRecord,
  buildSafetySubmissionUpdates,
  createSafetySubmissionError,
  normalizeSafetyCoordinate,
  normalizeSafetySubmissionInput,
} = require('./src/domains/safety/safetySubmission');
const {
  buildPhotoCollectionPath,
  buildPhotoVariantPaths,
  generatePhotoVariantsForRecord,
  hardenGroupSourceObjectMetadata,
  hardenPrivateSourceObjectMetadata,
  parseSourcePhotoPath,
} = require('./src/domains/media/photoVariants');
const {
  enforceGroupMediaAppCheck,
  GROUP_MEDIA_ALLOWED_TYPES,
  GROUP_MEDIA_MAX_UPLOAD_BYTES,
  GROUP_MEDIA_URL_TTL_MS,
  isGroupMediaPathForRecord,
  isPrivateMediaPathForRecord,
  normalizeGroupMediaRequest,
  normalizePrivateMediaRequest,
  PRIVATE_MEDIA_URL_TTL_MS,
  readGroupMediaRecords,
  readPrivateMediaRecords,
  signGroupMediaRecords,
  signPrivateMediaRecords,
  verifyCurrentTourPhotoAccess,
} = require('./src/domains/media/mediaAccess');
const privateMediaFunctions = require('./src/domains/media/privateMediaFunctions');
const groupMediaFunctions = require('./src/domains/media/groupMediaFunctions');
const {
  extensionForGroupPhotoContentType,
  normalizeGroupPhotoUploadMetadata,
  reserveGroupPhotoRecord,
} = groupMediaFunctions;
const {
  createGroupPhotoChatMessage,
  deleteGroupPhoto,
  resolveGroupPhotoMedia,
  uploadGroupPhoto,
} = groupMediaFunctions;
const {
  deletePrivatePhoto,
  normalizePrivatePhotoUploadMetadata,
  reservePrivatePhotoRecord,
  resolvePrivatePhotoMedia,
  uploadPrivatePhoto,
} = privateMediaFunctions;
const {
  applyRecipientCap,
  buildChatNotificationContent,
  buildSafetyNotificationContent,
  chunkArrayDeterministically,
  getPreferenceValue,
  getPushTokenIneligibilityReason,
  isSupportedTourNotificationCategory,
  isValidPushToken,
  normalizePushToken,
  normalizeTourKeyForComparison,
  readBooleanPreference,
  removeInvalidToken,
  resolveTourNotificationCategoryLabel,
  resolveTrimmedString,
  shouldRemoveInvalidToken,
  toRealtimeKeySegment,
  userWantsTourCategoryBroadcast,
  validateMessageData,
} = require('./src/domains/notifications/notificationPolicy');
const {
  collectAssignedDriverIds,
  collectExpoTokenFailures,
  fetchUsersSnapshot,
  filterOperationalRecipientsByActiveSession,
  isDriverProfileAssignedToTour,
  loadIdentityBindingsForPrincipal,
  resolveChatSenderParticipantIds,
  selectNotificationRecipients,
} = require('./src/domains/notifications/notificationRecipients');
const {
  buildNotificationReadCleanupJobId,
  buildPushNavigationData,
  buildTourNotificationId,
  buildTourNotificationRecord,
  enqueueNotificationReadCleanupJobs,
  fetchRealtimeDatabaseShallowKeys,
  persistTourNotification,
  processLegacyNotificationReadStateCleanup,
  processNotificationReadCleanupJob,
  processNotificationReadCleanupJobs,
  processNotificationReadMigrationRequest,
  shouldDeleteLegacyNotificationReadPrincipal,
  summarizeItineraryChange,
} = require('./src/domains/notifications/notificationState');
const {
  buildCategoryBroadcastPushMessages,
  isAdminBroadcast,
  loadDriverProfile,
  resolveAssignedDriverRecipientIds,
  resolveChatSenderDeliveryIds,
  verifyParticipant,
} = require('./src/domains/notifications/notificationDelivery');
const { cleanupInvalidTokens } = require('./src/domains/notifications/invalidTokenCleanup');
const tourIndexFunctions = require('./src/domains/maintenance/tourIndexFunctions');
const scheduledCleanupFunctions = require('./src/domains/maintenance/scheduledCleanupFunctions');
const { ingestDriverTourPacks } = require('./src/domains/driver-tour-packs/ingestionFunction');
const { normalizeManifestPassengerRows } = require('./lib/manifestPassengers');
const {
  INGESTION_LIMITS: DRIVER_TOUR_PACK_INGESTION_LIMITS,
  createDriverTourPackPublisher,
} = require('./lib/driverTourPackPublisher');
const {
  DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT,
  validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest,
} = require('./lib/managementOidc');
const { cleanupExpiredDriverTourPacks } = require('./lib/driverTourPackExpiryCleanup');
const { cleanupExpiredDriverLocations } = require('./lib/driverLocationExpiryCleanup');
const {
  createDistributedLoginRateLimiter,
  cleanupExpiredLoginRateLimits,
} = require('./lib/loginRateLimiter');
const {
  buildDriverTourPackActionProjectionUpdates,
  summarizeDriverTourPackChange,
} = require('./lib/driverTourPackOperations');
const { deriveTourDateIndexUpdate } = require('./lib/tourDateIndex');
const {
  PASSENGER_IDENTITY_VERSION,
  authorizePassengerLoginDevice,
  buildPassengerIdentitySecurityUpdates,
  ensureOpaquePassengerIdentity,
  isOpaquePassengerId,
} = require('./lib/passengerIdentity');
const {
  buildDriverSessionRecord,
  buildPassengerParticipantRecord,
  buildPassengerSessionRecord,
  calculateSessionExpiry,
  createAppSessionId,
  isActiveSessionRecord,
  isValidAppSessionId,
  toClientSession,
} = require('./lib/appSession');
const {
  acquireAppSessionLock,
  releaseAppSessionLock,
} = require('./lib/appSessionLock');
const { verifyActiveAppSession } = require('./lib/appSessionAccess');
const {
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  cleanupAppSession,
  cleanupDriverLocationForSession,
} = require('./lib/appSessionCleanup');

const NOTIFICATION_RECIPIENT_CAP = 1000;
const RECIPIENT_CHUNK_SIZE = 200;
const USER_PROFILE_FETCH_CHUNK_SIZE = 100;
const USER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;
const USER_PROFILE_CACHE_MAX_ENTRIES = 5000;
const TOUR_NOTIFICATION_MAX_RECORDS = 100;
const NOTIFICATION_READ_CLEANUP_JOB_BATCH_SIZE = 10;
const NOTIFICATION_READ_CLEANUP_USER_BATCH_SIZE = 50;
const LEGACY_NOTIFICATION_READ_CLEANUP_BATCH_SIZE = 50;
const LEGACY_NOTIFICATION_READ_CLEANUP_CONCURRENCY = 5;
const LEGACY_NOTIFICATION_READ_CLEANUP_STATE_PATH = 'notification_read_legacy_cleanup_state/v1';
const LEGACY_NOTIFICATION_READ_CLEANUP_QUEUE_PATH = 'notification_read_legacy_cleanup_queue';
const LEGACY_NOTIFICATION_READ_CLEANUP_SEED_BATCH_SIZE = 200;
const userProfileCache = new Map();
const PHOTO_CACHE_CONTROL_HEADER = "private,max-age=300,no-transform";
const PRIVATE_PHOTO_CACHE_CONTROL_HEADER = "private,no-store";
const REALTIME_KEY_INVALID_GLOBAL_PATTERN = /[.#$\/\[\]\x00-\x1F\x7F]/g;
const VERIFIED_LOGIN_GRANT_TTL_MS = 30 * 60 * 1000;
const MANUAL_BOOKING_LOCK_TTL_MS = 30 * 1000;
const DRIVER_ASSIGNMENT_LOCK_TTL_MS = 30 * 1000;
const TOUR_DELETION_LOCK_TTL_MS = 10 * 60 * 1000;
const SAFETY_SUBMISSION_LOCK_TTL_MS = 30 * 1000;
const SAFETY_RATE_LIMIT_ROOT = 'safety_rate_limits/v1';
const SAFETY_RATE_LIMIT_MAX_REQUESTS = 20;
const SAFETY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const OPERATIONS_ADMIN_UID = '9CWQ4705gVRkfW5Xki5LyvrmVp23';
const MANIFEST_STATUS = {
  PENDING: 'PENDING',
  BOARDED: 'BOARDED',
  NO_SHOW: 'NO_SHOW',
  PARTIAL: 'PARTIAL',
};
const TOUR_NOTIFICATION_CATEGORY_LABELS = {
  day_trips: 'Day Trips',
  mystery_breaks: 'Mystery Breaks',
  scotland_highlands_islands: 'Scotland, Highlands & Islands',
  isle_of_ireland: 'Isle of Ireland',
  european_breaks: 'European Breaks',
  steam_train_tours: 'Steam Train Tours',
  cruises_ferries: 'Cruises & Ferries',
  theatre_concerts: 'Theatre & Concerts',
  sporting_breaks: 'Sporting Breaks',
  history_military_breaks: 'History & Military Breaks',
};
const TOUR_NOTIFICATION_CATEGORY_KEYS = Object.freeze(Object.keys(TOUR_NOTIFICATION_CATEGORY_LABELS));
const PUSH_NOTIFICATION_SCREENS = new Set(['Chat', 'Itinerary', 'GroupPhotobook', 'NotificationPreferences', 'SafetySupport', 'DriverTourPack']);
const SAFETY_CATEGORIES = new Set([
  'delay',
  'incident',
  'medical',
  'lost_passenger',
  'vehicle_issue',
  'sos',
  'harassment',
  'weather',
  'custom',
]);
const SAFETY_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS = {
  mystery_breaks: ['mystery_tours'],
  scotland_highlands_islands: ['scotland_classics', 'hiking_nature'],
  steam_train_tours: ['steam_trains'],
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Validates message data
 */
const compactNotificationText = (value, maxLength = 220) => {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const verifyAdminBroadcast = async (messageData) => {
  const { senderUid } = messageData;

  // Admin broadcasts must include a senderUid for verification
  if (!senderUid || typeof senderUid !== 'string') {
    return false;
  }

  try {
    // Verify the UID belongs to a real, non-anonymous user (admins use email/password auth)
    const userRecord = await admin.auth().getUser(senderUid);
    if (!userRecord || userRecord.disabled) {
      return false;
    }

    // Admin users authenticate with email/password, not anonymously
    const isAnonymous = userRecord.providerData.length === 0;
    if (isAnonymous) {
      return false;
    }

    return true;
  } catch (error) {
    log.error('Admin broadcast verification failed', error, { senderUid });
    return false;
  }
};

/**
 * Validates a Firebase path segment to prevent path traversal attacks.
 * Firebase keys cannot contain '.', '$', '#', '[', ']', or '/'.
 */
const { verifyPassengerLogin } = require('./src/domains/passenger-auth/passengerLoginFunction');
exports.verifyPassengerLogin = verifyPassengerLogin;

const createManualPassengerBookingFunctionsdeleteTourDataFunctionsremoveReportedPhoto = require('./src/domains/administration/administrationFunctions.js');
exports.createManualPassengerBooking = createManualPassengerBookingFunctionsdeleteTourDataFunctionsremoveReportedPhoto.createManualPassengerBooking;
exports.deleteTourData = createManualPassengerBookingFunctionsdeleteTourDataFunctionsremoveReportedPhoto.deleteTourData;
exports.removeReportedPhoto = createManualPassengerBookingFunctionsdeleteTourDataFunctionsremoveReportedPhoto.removeReportedPhoto;

const { getTourManifest } = require('./src/domains/manifests/manifestFunction.js');
exports.getTourManifest = getTourManifest;

const { verifyDriverLogin } = require('./src/domains/driver-auth/driverLoginFunction.js');
exports.verifyDriverLogin = verifyDriverLogin;

const { assignDriverToTour } = require('./src/domains/driver-assignment/driverAssignmentFunction.js');
exports.assignDriverToTour = assignDriverToTour;

const endAppSessionFunctionsrevokeAppSession = require('./src/domains/app-sessions/sessionFunctions.js');
exports.endAppSession = endAppSessionFunctionsrevokeAppSession.endAppSession;
exports.revokeAppSession = endAppSessionFunctionsrevokeAppSession.revokeAppSession;

const { submitSafetyReport } = require('./src/domains/safety/safetyFunction.js');
exports.submitSafetyReport = submitSafetyReport;

const validateBroadcastData = (broadcastData) => {
  const errors = [];

  if (!broadcastData || typeof broadcastData !== 'object') {
    errors.push('Broadcast data is null or invalid');
    return { valid: false, errors };
  }

  if (!broadcastData.message || typeof broadcastData.message !== 'string') {
    errors.push('Missing broadcast message');
  } else if (broadcastData.message.trim().length === 0 || broadcastData.message.length > 2000) {
    errors.push('Broadcast message must be 1-2000 characters');
  }

  if (typeof broadcastData.createdAtMs !== 'number' || !Number.isFinite(broadcastData.createdAtMs)) {
    errors.push('Missing or invalid createdAtMs');
  }

  if (!broadcastData.createdByUid || typeof broadcastData.createdByUid !== 'string') {
    errors.push('Missing createdByUid');
  }

  if (broadcastData.source && typeof broadcastData.source !== 'string') {
    errors.push('Invalid source');
  }

  return { valid: errors.length === 0, errors };
};

const validateCategoryBroadcastData = (categoryKey, broadcastData) => {
  const validation = validateBroadcastData(broadcastData);
  const errors = [...validation.errors];

  if (!isSupportedTourNotificationCategory(categoryKey)) {
    errors.push('Unsupported tour notification category');
  }

  if (broadcastData?.categoryKey && broadcastData.categoryKey !== categoryKey) {
    errors.push('categoryKey must match the broadcast path');
  }

  if (broadcastData?.categoryLabel && (
    typeof broadcastData.categoryLabel !== 'string'
    || broadcastData.categoryLabel.trim().length === 0
    || broadcastData.categoryLabel.length > 120
  )) {
    errors.push('Invalid categoryLabel');
  }

  return { valid: errors.length === 0, errors };
};

const BROADCAST_TERMINAL_STATUSES = new Set(['delivered', 'partial', 'failed', 'no_recipients']);

const resolveBroadcastDeliveryStatus = ({ successCount = 0, errorCount = 0, recipientCount = 0 } = {}) => {
  if (recipientCount <= 0) return 'no_recipients';
  if (successCount > 0 && errorCount > 0) return 'partial';
  if (successCount > 0) return 'delivered';
  return 'failed';
};

const updateBroadcastDelivery = async ({ root, targetId, broadcastId, status, details = {} }) => {
  if (!isValidFirebaseKey(targetId) || !isValidFirebaseKey(broadcastId)) return;
  const now = Date.now();
  const payload = {
    deliveryStatus: status,
    deliveryUpdatedAtMs: now,
    ...details,
  };
  if (BROADCAST_TERMINAL_STATUSES.has(status)) payload.deliveryCompletedAtMs = now;
  await admin.database().ref(`${root}/${targetId}/${broadcastId}`).update(payload);
};

const fetchCategoryBroadcastUsers = async (categoryKey, context = {}) => {
  const usersMap = {};
  const preferenceKeys = [
    categoryKey,
    ...(LEGACY_TOUR_NOTIFICATION_CATEGORY_PREF_KEYS[categoryKey] || []),
  ];

  for (const preferenceKey of preferenceKeys) {
    const snapshot = await admin.database()
      .ref('users')
      .orderByChild(`preferences/marketing/${preferenceKey}`)
      .equalTo(true)
      .limitToFirst(NOTIFICATION_RECIPIENT_CAP + 1)
      .once('value');

    const users = snapshot.val() || {};
    Object.entries(users).forEach(([userId, userData]) => {
      usersMap[userId] = userData;
      setCachedUserProfile(userId, userData);
    });

    if (Object.keys(users).length > NOTIFICATION_RECIPIENT_CAP) {
      log.warn('Category broadcast preference query exceeded recipient cap', {
        ...context,
        preferenceKey,
        cap: NOTIFICATION_RECIPIENT_CAP,
      });
    }
  }

  log.info('Fetched category broadcast users', {
    ...context,
    preferenceQueryCount: preferenceKeys.length,
    resolvedUserCount: Object.keys(usersMap).length,
  });

  return usersMap;
};

/**
 * Trigger: When a new admin broadcast is written to /broadcasts/{tourId}/{broadcastId}
 * Writes a normalized system chat message so existing chat notification flow can fan out push notifications.
 */
exports.processBroadcastWrite = onValueCreated(
  {
    ref: '/broadcasts/{tourId}/{broadcastId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  async (event) => {
    const { tourId, broadcastId } = event.params;

    try {
      if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(broadcastId)) {
        log.warn('Invalid broadcast path parameters', { tourId, broadcastId });
        return null;
      }

      const broadcastData = event.data?.val();
      const validation = validateBroadcastData(broadcastData);
      if (!validation.valid) {
        log.warn('Invalid broadcast payload; skipping fanout', { tourId, broadcastId, errors: validation.errors });
        await updateBroadcastDelivery({
          root: 'broadcasts', targetId: tourId, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_PAYLOAD' },
        });
        return null;
      }

      await updateBroadcastDelivery({ root: 'broadcasts', targetId: tourId, broadcastId, status: 'processing' });

      const adminRecord = await admin.auth().getUser(broadcastData.createdByUid);
      const isAnonymous = adminRecord.providerData.length === 0;
      if (adminRecord.disabled || isAnonymous) {
        log.warn('Broadcast author is not eligible for admin broadcast fanout', {
          tourId,
          broadcastId,
          createdByUid: broadcastData.createdByUid,
        });
        await updateBroadcastDelivery({
          root: 'broadcasts', targetId: tourId, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_AUTHOR' },
        });
        return null;
      }

      await admin.database().ref(`chats/${tourId}/messages/${broadcastId}`).set({
        text: `ANNOUNCEMENT: ${broadcastData.message.trim()}`,
        senderName: 'Loch Lomond Travel HQ',
        senderId: 'admin_hq_broadcast',
        senderUid: broadcastData.createdByUid,
        timestamp: broadcastData.createdAtMs,
        messageType: 'ADMIN_BROADCAST',
        source: broadcastData.source || 'web_admin',
        isDriver: true,
        broadcastId,
      });

      await persistTourNotification({
        record: buildTourNotificationRecord({
          type: 'announcement',
          tourId,
          sourceId: broadcastId,
          title: 'Loch Lomond Travel update',
          body: broadcastData.message,
          screen: 'Chat',
          messageId: broadcastId,
          createdAtMs: broadcastData.createdAtMs,
          priority: 'high',
        }),
      });

      await updateBroadcastDelivery({ root: 'broadcasts', targetId: tourId, broadcastId, status: 'chat_queued' });
      log.info('Broadcast fanout to chat completed', { tourId, broadcastId });
      return null;
    } catch (error) {
      log.error('Failed to process broadcast write', error, { tourId, broadcastId });
      await updateBroadcastDelivery({
        root: 'broadcasts', targetId: tourId, broadcastId, status: 'failed', details: { deliveryErrorCode: 'FANOUT_FAILED' },
      }).catch((statusError) => log.error('Failed to persist broadcast failure status', statusError, { tourId, broadcastId }));
      return null;
    }
  }
);

/**
 * Trigger: When a new admin category broadcast is written to
 * /category_broadcasts/{categoryKey}/{broadcastId}
 * Sends a direct push to clients who opted in to that future-tour category.
 */
exports.processCategoryBroadcastWrite = onValueCreated(
  {
    ref: '/category_broadcasts/{categoryKey}/{broadcastId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const { categoryKey, broadcastId } = event.params;

    try {
      if (!isValidFirebaseKey(categoryKey) || !isValidFirebaseKey(broadcastId)) {
        log.warn('Invalid category broadcast path parameters', { categoryKey, broadcastId });
        return null;
      }

      const broadcastData = event.data?.val();
      const validation = validateCategoryBroadcastData(categoryKey, broadcastData);
      if (!validation.valid) {
        log.warn('Invalid category broadcast payload; skipping fanout', {
          categoryKey,
          broadcastId,
          errors: validation.errors,
        });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_PAYLOAD' },
        });
        return null;
      }

      await updateBroadcastDelivery({ root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'processing' });

      const adminRecord = await admin.auth().getUser(broadcastData.createdByUid);
      const isAnonymous = adminRecord.providerData.length === 0;
      if (adminRecord.disabled || isAnonymous) {
        log.warn('Category broadcast author is not eligible for fanout', {
          categoryKey,
          broadcastId,
          createdByUid: broadcastData.createdByUid,
        });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'failed', details: { deliveryErrorCode: 'INVALID_AUTHOR' },
        });
        return null;
      }

      const categoryLabel = resolveTourNotificationCategoryLabel(categoryKey);
      const usersMap = await fetchCategoryBroadcastUsers(categoryKey, {
        categoryKey,
        notificationType: 'category_broadcast',
      });
      const candidateUserIds = applyRecipientCap(Object.keys(usersMap), NOTIFICATION_RECIPIENT_CAP, {
        categoryKey,
        notificationType: 'category_broadcast',
      });

      if (candidateUserIds.length === 0) {
        log.info('No users opted in to category broadcast', { categoryKey, broadcastId });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'no_recipients', details: { recipientCount: 0, successCount: 0, errorCount: 0 },
        });
        return null;
      }

      const assemblyStart = Date.now();
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: candidateUserIds,
        usersMap,
        preferencePath: ['preferences', 'marketing', categoryKey],
        preferenceResolver: (userData) => userWantsTourCategoryBroadcast(userData, categoryKey),
        senderId: null,
        excludeSender: false,
        context: { categoryKey, broadcastId, notificationType: 'category_broadcast' },
      });

      const pushMessages = buildCategoryBroadcastPushMessages({
        validRecipients,
        categoryKey,
        categoryLabel,
        broadcastId,
        message: broadcastData.message,
        timestamp: broadcastData.createdAtMs,
      });

      log.info('Using deterministic recipient chunking for category broadcast notifications', {
        categoryKey,
        broadcastId,
        chunks: Math.ceil(pushMessages.length / RECIPIENT_CHUNK_SIZE),
        chunkSize: RECIPIENT_CHUNK_SIZE,
      });
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens);
      }

      if (pushMessages.length === 0) {
        log.info('No valid recipients for category broadcast', { categoryKey, broadcastId });
        await updateBroadcastDelivery({
          root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'no_recipients', details: { recipientCount: 0, successCount: 0, errorCount: 0 },
        });
        return null;
      }

      const expo = getExpoPushClient();
      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;
      const pushSendStart = Date.now();

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          const deviceNotRegisteredFailures = collectExpoTokenFailures(ticketChunk, chunk);

          ticketChunk.forEach((ticket) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error('Category broadcast notification ticket error', {
                error: ticket.message,
                details: ticket.details,
              }, { categoryKey, broadcastId });
            } else {
              successCount++;
            }
          });

          if (deviceNotRegisteredFailures.length > 0) {
            await Promise.all(deviceNotRegisteredFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
              if (!recipient?.userId) return;
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }));
          }
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error('Error sending category broadcast chunk', chunkError, {
            categoryKey,
            broadcastId,
            chunkSize: chunk.length,
          });
        }
      }

      const pushSendDurationMs = Date.now() - pushSendStart;
      const duration = Date.now() - startTime;
      await updateBroadcastDelivery({
        root: 'category_broadcasts',
        targetId: categoryKey,
        broadcastId,
        status: resolveBroadcastDeliveryStatus({ successCount, errorCount, recipientCount: pushMessages.length }),
        details: { recipientCount: pushMessages.length, successCount, errorCount },
      });
      log.info('Category broadcast notification completed', {
        categoryKey,
        broadcastId,
        recipients: pushMessages.length,
        successCount,
        errorCount,
        payloadAssemblyDurationMs,
        pushSendDurationMs,
        duration: `${duration}ms`,
      });

      return null;
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error('Fatal error in processCategoryBroadcastWrite', error, {
        categoryKey,
        broadcastId,
        duration: `${duration}ms`,
      });
      await updateBroadcastDelivery({
        root: 'category_broadcasts', targetId: categoryKey, broadcastId, status: 'failed', details: { deliveryErrorCode: 'FANOUT_FAILED' },
      }).catch((statusError) => log.error('Failed to persist category broadcast failure status', statusError, { categoryKey, broadcastId }));
      return null;
    }
  }
);

/**
 * Trigger: When a new message is added to /chats/{tourId}/messages/{messageId}
 * Enhanced with validation, security checks, and better error handling
 */
exports.sendChatNotification = onValueCreated(
  {
    ref: "/chats/{tourId}/messages/{messageId}",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const tourId = event.params.tourId;
    const messageId = event.params.messageId;
    const initialMessageData = event.data?.val?.() || {};
    const trackedBroadcastId = resolveTrimmedString(initialMessageData.broadcastId);
    const updateTrackedBroadcast = (status, details = {}) => (
      trackedBroadcastId
        ? updateBroadcastDelivery({ root: 'broadcasts', targetId: tourId, broadcastId: trackedBroadcastId, status, details })
        : Promise.resolve()
    );

    try {
      // 0. Validate path parameters
      if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(messageId)) {
        log.error("Invalid path parameters", null, { tourId, messageId });
        return null;
      }

      // 1. Validate event data
      const snapshot = event.data;
      if (!snapshot) {
        log.warn("No data associated with event", { tourId, messageId });
        return null;
      }

      const messageData = initialMessageData;

      // 2. Validate message data
      const validation = validateMessageData(messageData);
      if (!validation.valid) {
        log.error("Invalid message data", { errors: validation.errors }, { tourId, messageId });
        await updateTrackedBroadcast('failed', { deliveryErrorCode: 'INVALID_CHAT_MESSAGE' });
        return null;
      }

      const { senderId, senderName } = messageData;

      // 3. Rate limiting check (prevent spam)
      const rateLimitKey = `chat_notify_${tourId}_${senderId}`;
      if (!checkRateLimit(rateLimitKey, 20, 60000)) {
        log.warn("Rate limit exceeded", { tourId, senderId });
        if (isAdminBroadcast(senderId)) await updateTrackedBroadcast('failed', { deliveryErrorCode: 'RATE_LIMITED' });
        return null;
      }

      // 4. Security: Verify admin broadcast authenticity up-front.
      let isAdmin = isAdminBroadcast(senderId);
      if (isAdmin) {
        // Verify the admin broadcast is legitimate (not spoofed by a regular user)
        const isVerifiedAdmin = await verifyAdminBroadcast(messageData);
        if (!isVerifiedAdmin) {
          log.error("Spoofed admin broadcast rejected - invalid or missing senderUid", null, { tourId, senderId });
          await updateTrackedBroadcast('failed', { deliveryErrorCode: 'INVALID_AUTHOR' });
          return null;
        }
      }

      log.info("Processing chat notification", { tourId, senderId, senderName, isAdmin });

      // 5. Get only the fields needed for notifications.
      const [tourNameSnapshot, participantsSnapshot, manifestSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/name`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value"),
        admin.database().ref(`tour_manifests/${tourId}`).once("value"),
      ]);

      const tourName = tourNameSnapshot.val() || "Tour Chat";
      const participants = participantsSnapshot.val() || {};
      const manifestData = manifestSnapshot.val() || {};
      const participantIds = Object.keys(participants);
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData,
        context: { tourId, messageId, notificationType: 'chat' },
      });
      let senderDeliveryIds = [];

      // Security: regular chat messages must be sent by a participant.
      if (!isAdmin) {
        senderDeliveryIds = await resolveChatSenderDeliveryIds({
          tourId,
          participants,
          manifestData,
          messageData,
          context: { tourId, messageId, notificationType: 'chat' },
        });
      }

      if (!isAdmin) {
        senderDeliveryIds = await filterOperationalRecipientsByActiveSession({
          recipientIds: senderDeliveryIds,
          tourId,
          participants,
        });
      }
      if (!isAdmin && senderDeliveryIds.length === 0) {
        log.error("Sender is not an active participant or assigned driver of the tour", null, {
          tourId,
          senderId,
          senderStableId: toRealtimeKeySegment(messageData.senderStableId),
        });
        return null;
      }

      const audienceIds = [...new Set([...participantIds, ...assignedDriverRecipientIds])];
      const activeAudienceIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: audienceIds,
        tourId,
        participants,
      });
      const cappedParticipantIds = applyRecipientCap(activeAudienceIds, NOTIFICATION_RECIPIENT_CAP, {
        tourId,
        notificationType: 'chat',
      });

      const fetchUsersStart = Date.now();
      const usersMap = await fetchUsersSnapshot(cappedParticipantIds, { tourId, notificationType: 'chat' });
      const userFetchDurationMs = Date.now() - fetchUsersStart;

      const assemblyStart = Date.now();
      const prefKey = isAdmin ? 'driver_updates' : 'group_chat';
      const preferencePath = ['preferences', 'ops', prefKey];
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedParticipantIds,
        usersMap,
        preferencePath,
        senderId,
        senderParticipantIds: senderDeliveryIds,
        excludeSender: true,
        context: { tourId, notificationType: 'chat' },
      });

      const notificationContent = buildChatNotificationContent({
        messageData,
        tourName,
        isAdmin,
      });
      const pushMessages = [];

      const recipientChunks = chunkArrayDeterministically(
        validRecipients.map((recipient) => recipient.userId),
        RECIPIENT_CHUNK_SIZE,
      );
      log.info('Using deterministic recipient chunking for chat notifications', {
        tourId,
        chunks: recipientChunks.length,
        chunkSize: RECIPIENT_CHUNK_SIZE,
      });

      for (const recipientChunk of recipientChunks) {
        for (const userId of recipientChunk) {
          const userData = usersMap[userId];
          pushMessages.push({
            to: userData.pushToken,
            sound: "default",
            title: notificationContent.title,
            body: notificationContent.body,
            data: buildPushNavigationData({
              tourId,
              screen: "Chat",
              messageId,
              noticeId: isAdmin && trackedBroadcastId
                ? buildTourNotificationId({ type: 'announcement', tourId, sourceId: trackedBroadcastId })
                : null,
              notificationType: isAdmin ? 'announcement' : 'chat_message',
            }),
            priority: isAdmin ? "high" : "default",
            channelId: "default",
          });
        }
      }
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      // 7. Complete invalid-token cleanup before the serverless invocation exits.
      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens);
      }

      // 8. Send notifications via Expo
      if (pushMessages.length === 0) {
        log.info("No valid recipients found", { tourId });
        if (isAdmin) await updateTrackedBroadcast('no_recipients', { recipientCount: 0, successCount: 0, errorCount: 0 });
        return null;
      }

      const expo = getExpoPushClient();
      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;
      const pushSendStart = Date.now();

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          const deviceNotRegisteredFailures = collectExpoTokenFailures(ticketChunk, chunk);

          // Check for errors in tickets
          ticketChunk.forEach((ticket) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error("Notification ticket error", {
                error: ticket.message,
                details: ticket.details
              }, { tourId });
            } else {
              successCount++;
            }
          });

          if (deviceNotRegisteredFailures.length > 0) {
            await Promise.all(deviceNotRegisteredFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
              if (!recipient?.userId) return;
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }));
          }
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error("Error sending notification chunk", chunkError, { tourId, chunkSize: chunk.length });
        }
      }
      const pushSendDurationMs = Date.now() - pushSendStart;

      const duration = Date.now() - startTime;
      if (isAdmin) {
        await updateTrackedBroadcast(
          resolveBroadcastDeliveryStatus({ successCount, errorCount, recipientCount: pushMessages.length }),
          { recipientCount: pushMessages.length, successCount, errorCount },
        );
      }
      log.info("Chat notification completed", {
        tourId,
        recipients: pushMessages.length,
        passengerRecipientCount: participantIds.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
        successCount,
        errorCount,
        isAdminBroadcast: isAdmin,
        userFetchDurationMs,
        payloadAssemblyDurationMs,
        pushSendDurationMs,
        duration: `${duration}ms`
      });

      return null;

    } catch (error) {
      const duration = Date.now() - startTime;
      log.error("Fatal error in sendChatNotification", error, { tourId, messageId, duration: `${duration}ms` });
      await updateTrackedBroadcast('failed', { deliveryErrorCode: 'NOTIFICATION_FAILED' })
        .catch((statusError) => log.error('Failed to persist tour broadcast failure status', statusError, { tourId, messageId }));
      return null;
    }
  }
);

/** Notify the other assigned drivers when an internal driver-chat message is created. */
exports.sendInternalChatNotification = onValueCreated(
  {
    ref: "/internal_chats/{tourId}/messages/{messageId}",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const tourId = event.params.tourId;
    const messageId = event.params.messageId;
    const messageData = event.data?.val?.() || {};

    try {
      if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(messageId)) return null;
      const validation = validateMessageData(messageData);
      if (!validation.valid || messageData.isDriver !== true) {
        log.warn('Invalid internal chat message skipped', { tourId, messageId, errors: validation.errors });
        return null;
      }
      if (!checkRateLimit(`internal_chat_notify_${tourId}_${messageData.senderId}`, 20, 60000)) {
        log.warn('Internal chat notification rate limit exceeded', { tourId });
        return null;
      }

      const [tourNameSnapshot, manifestSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/name`).once('value'),
        admin.database().ref(`tour_manifests/${tourId}`).once('value'),
      ]);
      const manifestData = manifestSnapshot.val() || {};
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData,
        context: { tourId, messageId, notificationType: 'internal_chat' },
      });
      const senderDeliveryIds = await resolveChatSenderDeliveryIds({
        tourId,
        manifestData,
        messageData,
        context: { tourId, messageId, notificationType: 'internal_chat' },
      });
      if (senderDeliveryIds.length === 0) {
        log.warn('Internal chat sender is not an active assigned driver', { tourId, messageId });
        return null;
      }

      const activeDriverRecipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: assignedDriverRecipientIds,
        tourId,
      });
      const activeSenderDeliveryIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: senderDeliveryIds,
        tourId,
      });
      if (activeSenderDeliveryIds.length === 0) {
        log.warn('Internal chat sender has no active app session', { tourId, messageId });
        return null;
      }
      const cappedRecipientIds = applyRecipientCap(
        activeDriverRecipientIds,
        NOTIFICATION_RECIPIENT_CAP,
        { tourId, notificationType: 'internal_chat' },
      );
      const usersMap = await fetchUsersSnapshot(cappedRecipientIds, { tourId, notificationType: 'internal_chat' });
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedRecipientIds,
        usersMap,
        preferencePath: ['preferences', 'ops', 'group_chat'],
        senderId: messageData.senderId,
        senderParticipantIds: activeSenderDeliveryIds,
        excludeSender: true,
        context: { tourId, notificationType: 'internal_chat' },
      });
      if (invalidTokens.length > 0) await cleanupInvalidTokens(invalidTokens);

      const tourName = tourNameSnapshot.val() || 'Tour Chat';
      const content = buildChatNotificationContent({ messageData, tourName });
      const pushMessages = validRecipients.map(({ userId }) => ({
        to: usersMap[userId].pushToken,
        sound: 'default',
        title: `Driver team · ${tourName}`,
        body: content.body,
        data: buildPushNavigationData({
          tourId,
          screen: 'Chat',
          messageId,
          notificationType: 'internal_chat_message',
          internalDriverChat: true,
        }),
        priority: 'default',
        channelId: 'default',
      }));

      let successCount = 0;
      let errorCount = 0;
      const expo = getExpoPushClient();
      for (const chunk of expo.chunkPushNotifications(pushMessages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          const deviceFailures = collectExpoTokenFailures(tickets, chunk);
          successCount += tickets.filter((ticket) => ticket.status !== 'error').length;
          errorCount += tickets.filter((ticket) => ticket.status === 'error').length;
          await Promise.all(deviceFailures.map(async ({ token, errorCode }) => {
            const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
            if (recipient?.userId) {
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }
          }));
        } catch (error) {
          errorCount += chunk.length;
          log.error('Internal chat notification chunk failed', error, { tourId, chunkSize: chunk.length });
        }
      }

      log.info('Internal chat notification completed', {
        tourId,
        messageId,
        recipients: pushMessages.length,
        successCount,
        errorCount,
      });
      return null;
    } catch (error) {
      log.error('Fatal error in sendInternalChatNotification', error, { tourId, messageId });
      return null;
    }
  },
);

exports.sendSafetyAlertNotification = onValueCreated(
  {
    ref: '/tours/{tourId}/safetyAlerts/{eventId}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 20,
  },
  async (event) => {
    const tourId = event.params.tourId;
    const eventId = event.params.eventId;
    const alert = event.data?.val?.() || {};
    if (!isValidFirebaseKey(tourId) || !isValidFirebaseKey(eventId)) return null;
    if (
      resolveTrimmedString(alert.tourId) !== tourId
      || resolveTrimmedString(alert.status) !== 'pending'
      || !SAFETY_CATEGORIES.has(resolveTrimmedString(alert.category)?.toLowerCase())
      || !SAFETY_SEVERITIES.has(resolveTrimmedString(alert.severity)?.toLowerCase())
      || (alert.schemaVersion === 2 && resolveTrimmedString(alert.eventId) !== eventId)
    ) {
      log.warn('Invalid safety alert skipped for notification', { tourId, eventId });
      return null;
    }

    const db = admin.database();
    try {
      const [tourNameSnapshot, manifestSnapshot, adminUsersSnapshot] = await Promise.all([
        db.ref(`tours/${tourId}/name`).once('value'),
        db.ref(`tour_manifests/${tourId}`).once('value'),
        db.ref('admin_users').once('value'),
      ]);
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData: manifestSnapshot.val() || {},
        context: { tourId, eventId, notificationType: 'safety_alert' },
      });
      const delegatedAdminIds = Object.entries(adminUsersSnapshot.val() || {})
        .filter(([, enabled]) => enabled === true)
        .map(([uid]) => uid);
      const activeDriverRecipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: assignedDriverRecipientIds,
        tourId,
      });
      const audienceIds = applyRecipientCap(
        [...new Set([OPERATIONS_ADMIN_UID, ...delegatedAdminIds, ...activeDriverRecipientIds])],
        NOTIFICATION_RECIPIENT_CAP,
        { tourId, notificationType: 'safety_alert' },
      );
      const usersMap = await fetchUsersSnapshot(audienceIds, { tourId, notificationType: 'safety_alert' });
      const reporterAuthUid = resolveTrimmedString(alert.reporterAuthUid || alert.userId);
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: audienceIds,
        usersMap,
        preferenceResolver: () => true,
        senderId: reporterAuthUid,
        senderParticipantIds: reporterAuthUid ? [reporterAuthUid] : [],
        excludeSender: true,
        context: { tourId, notificationType: 'safety_alert' },
      });
      if (invalidTokens.length > 0) await cleanupInvalidTokens(invalidTokens);

      const content = buildSafetyNotificationContent({
        alert,
        tourName: tourNameSnapshot.val() || tourId,
      });
      const pushMessages = validRecipients.map(({ userId }) => ({
        to: usersMap[userId].pushToken,
        sound: 'default',
        title: content.title,
        body: content.body,
        data: buildPushNavigationData({
          tourId,
          screen: 'SafetySupport',
          notificationType: alert.isSOS === true || alert.severity === 'critical'
            ? 'critical_safety_alert'
            : 'safety_alert',
        }),
        priority: content.priority,
        channelId: 'default',
      }));

      let successCount = 0;
      let errorCount = 0;
      const expo = getExpoPushClient();
      for (const chunk of expo.chunkPushNotifications(pushMessages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          const deviceFailures = collectExpoTokenFailures(tickets, chunk);
          successCount += tickets.filter((ticket) => ticket.status !== 'error').length;
          errorCount += tickets.filter((ticket) => ticket.status === 'error').length;
          await Promise.all(deviceFailures.map(async ({ token, errorCode }) => {
            const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
            if (recipient?.userId) {
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }
          }));
        } catch (error) {
          errorCount += chunk.length;
          log.error('Safety notification chunk failed', error, { tourId, eventId, chunkSize: chunk.length });
        }
      }

      const deliveryStatus = pushMessages.length === 0
        ? 'no_recipients'
        : errorCount === 0
          ? 'accepted'
          : successCount > 0
            ? 'partial'
            : 'failed';
      const deliveryUpdate = {
        notificationDeliveryStatus: deliveryStatus,
        notificationRecipientCount: pushMessages.length,
        notificationSuccessCount: successCount,
        notificationErrorCount: errorCount,
        notificationUpdatedAtMs: Date.now(),
      };
      const mirrorUpdates = Object.fromEntries(
        Object.entries(deliveryUpdate).flatMap(([key, value]) => [
          [`tours/${tourId}/safetyAlerts/${eventId}/${key}`, value],
          ...(alert.isSOS === true || alert.severity === 'critical'
            ? [[`globalSafetyAlerts/${eventId}/${key}`, value]]
            : []),
        ]),
      );
      await db.ref().update(mirrorUpdates);
      log.info('Safety notification completed', {
        tourId,
        eventId,
        recipients: pushMessages.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
        successCount,
        errorCount,
        deliveryStatus,
      });
      return null;
    } catch (error) {
      log.error('Fatal error in sendSafetyAlertNotification', error, { tourId, eventId });
      await db.ref(`tours/${tourId}/safetyAlerts/${eventId}`).update({
        notificationDeliveryStatus: 'failed',
        notificationUpdatedAtMs: Date.now(),
      }).catch(() => {});
      return null;
    }
  },
);

const findPhotoRecordByStoragePath = async ({
  dbRoot,
  objectPath,
  maxAttempts = 5,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await dbRoot
      .orderByChild('storagePath')
      .equalTo(objectPath)
      .once('value');
    const [photoId, photoRecord] = Object.entries(snapshot.val() || {})[0] || [];
    if (photoId && photoRecord?.storagePath === objectPath) return { photoId, photoRecord };
    if (attempt < maxAttempts - 1) await wait(Math.min(250 * (2 ** attempt), 2_000));
  }
  return null;
};

const isPhotoVariantRecordReady = ({ visibility: _visibility, photoRecord }) => {
  if (photoRecord?.variantStatus !== "ready") return false;
  return Boolean(photoRecord.viewerStoragePath && photoRecord.thumbnailStoragePath);
};

const processPhotoVariantObject = async (event) => {
    const objectData = event.data || {};
    const bucketName = objectData.bucket;
    const objectPath = objectData.name || "";
    const metadata = objectData.metadata || {};

    if (!bucketName || !objectPath) {
      return null;
    }

    if (metadata.variant && metadata.variant !== "source") {
      return null;
    }

    const parsed = parseSourcePhotoPath(objectPath);
    if (!parsed) {
      return null;
    }

    const { tourId, visibility, ownerKey } = parsed;
    if (!tourId) {
      return null;
    }

    const dbRoot = admin.database().ref(buildPhotoCollectionPath({ visibility, tourId, ownerKey }));
    const match = await findPhotoRecordByStoragePath({ dbRoot, objectPath });
    if (!match) return null;
    const { photoId, photoRecord } = match;
    if (isPhotoVariantRecordReady({ visibility, photoRecord })) {
      return null;
    }

    await generatePhotoVariantsForRecord({
      bucketName,
      visibility,
      tourId,
      ownerKey,
      photoId,
      photoRecord: {
        ...photoRecord,
        storagePath: objectPath,
      },
    });

    return null;
  };

exports.generatePhotoVariants = onObjectFinalized(
  {
    // Storage triggers must run in the same region as the bucket.
    // We keep this trigger in us-east1 to match Firebase free-tier bucket location.
    region: "us-east1",
    maxInstances: 10,
  },
  processPhotoVariantObject,
);
/**
 * Trigger: When the itinerary is published, updated, or withdrawn.
 * Enhanced with validation, better error handling, and performance tracking
 */
exports.sendItineraryNotification = onValueWritten(
  {
    ref: "/tours/{tourId}/itinerary",
    region: "europe-west1",
    instance: "loch-lomond-travel-default-rtdb",
    maxInstances: 10,
  },
  async (event) => {
    const startTime = Date.now();
    const tourId = event.params.tourId;

    try {
      // 0. Validate path parameters
      if (!isValidFirebaseKey(tourId)) {
        log.error("Invalid tourId path parameter", null, { tourId });
        return null;
      }

      log.info("Processing itinerary update notification", { tourId });

      const itineraryChange = summarizeItineraryChange(
        event.data?.before?.val?.() || {},
        event.data?.after?.val?.() || {},
      );
      if (!itineraryChange.hasMeaningfulChange) {
        log.info('Skipping metadata-only itinerary notification', { tourId });
        return null;
      }
      // 1. Rate limiting check (prevent notification spam on rapid updates)
      const rateLimitKey = `itinerary_notify_${tourId}`;
      if (!checkRateLimit(rateLimitKey, 5, 300000)) { // Max 5 updates per 5 minutes
        log.warn("Itinerary update rate limit exceeded", { tourId });
        return null;
      }

      // 2. Get only fields required for itinerary notifications.
      const [isActiveSnapshot, participantsSnapshot, manifestSnapshot] = await Promise.all([
        admin.database().ref(`tours/${tourId}/isActive`).once("value"),
        admin.database().ref(`tours/${tourId}/participants`).once("value"),
        admin.database().ref(`tour_manifests/${tourId}`).once("value"),
      ]);

      // Check if tour is active
      if (isActiveSnapshot.val() === false) {
        log.info("Tour is inactive, skipping notification", { tourId });
        return null;
      }

      const itineraryNotice = buildTourNotificationRecord({
          type: 'itinerary',
          tourId,
          sourceId: event.id || `${Date.now()}`,
          title: itineraryChange.title,
          body: itineraryChange.body,
          screen: 'Itinerary',
          createdAtMs: Date.now(),
          priority: 'high',
        });
      await persistTourNotification({
        record: itineraryNotice,
      });

      const participants = participantsSnapshot.exists() ? (participantsSnapshot.val() || {}) : {};
      const participantIds = Object.keys(participants);
      const assignedDriverRecipientIds = await resolveAssignedDriverRecipientIds({
        tourId,
        manifestData: manifestSnapshot.val() || {},
        context: { tourId, notificationType: 'itinerary' },
      });
      const recipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds: [...new Set([...participantIds, ...assignedDriverRecipientIds])],
        tourId,
        participants,
      });

      if (recipientIds.length === 0) {
        log.info("No participants or assigned drivers for itinerary update", { tourId });
        return null;
      }

      const cappedRecipientIds = applyRecipientCap(recipientIds, NOTIFICATION_RECIPIENT_CAP, {
        tourId,
        notificationType: 'itinerary',
      });

      const fetchUsersStart = Date.now();
      const usersMap = await fetchUsersSnapshot(cappedRecipientIds, { tourId, notificationType: 'itinerary' });
      const userFetchDurationMs = Date.now() - fetchUsersStart;

      const assemblyStart = Date.now();
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedRecipientIds,
        usersMap,
        preferencePath: ['preferences', 'ops', 'itinerary_changes'],
        senderId: null,
        excludeSender: false,
        context: { tourId, notificationType: 'itinerary' },
      });

      const pushMessages = [];
      const recipientChunks = chunkArrayDeterministically(
        validRecipients.map((recipient) => recipient.userId),
        RECIPIENT_CHUNK_SIZE,
      );
      log.info('Using deterministic recipient chunking for itinerary notifications', {
        tourId,
        chunks: recipientChunks.length,
        chunkSize: RECIPIENT_CHUNK_SIZE,
        passengerRecipientCount: participantIds.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
      });

      for (const recipientChunk of recipientChunks) {
        for (const userId of recipientChunk) {
          const userData = usersMap[userId];
          pushMessages.push({
            to: userData.pushToken,
            sound: "default",
            title: itineraryChange.title,
            body: itineraryChange.body,
            data: buildPushNavigationData({
              tourId,
              screen: "Itinerary",
              noticeId: itineraryNotice.noticeId,
              notificationType: 'itinerary',
            }),
            priority: "default",
            channelId: "default",
          });
        }
      }
      const payloadAssemblyDurationMs = Date.now() - assemblyStart;

      // 4. Complete invalid-token cleanup before the serverless invocation exits.
      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens);
      }

      // 5. Send notifications via Expo
      if (pushMessages.length === 0) {
        log.info("No valid recipients for itinerary update", { tourId });
        return null;
      }

      const expo = getExpoPushClient();
      const chunks = expo.chunkPushNotifications(pushMessages);
      let successCount = 0;
      let errorCount = 0;
      const pushSendStart = Date.now();

      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          const deviceNotRegisteredFailures = collectExpoTokenFailures(ticketChunk, chunk);

          // Check for errors in tickets
          ticketChunk.forEach((ticket) => {
            if (ticket.status === 'error') {
              errorCount++;
              log.error("Notification ticket error", {
                error: ticket.message,
                details: ticket.details
              }, { tourId });
            } else {
              successCount++;
            }
          });

          if (deviceNotRegisteredFailures.length > 0) {
            await Promise.all(deviceNotRegisteredFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate?.userData?.pushToken === token);
              if (!recipient?.userId) return;
              await removeInvalidToken(recipient.userId, token, { reason: errorCode || 'DEVICE_NOT_REGISTERED' });
            }));
          }
        } catch (chunkError) {
          errorCount += chunk.length;
          log.error("Error sending notification chunk", chunkError, { tourId, chunkSize: chunk.length });
        }
      }
      const pushSendDurationMs = Date.now() - pushSendStart;

      const duration = Date.now() - startTime;
      log.info("Itinerary notification completed", {
        tourId,
        recipients: pushMessages.length,
        passengerRecipientCount: participantIds.length,
        assignedDriverRecipientCount: assignedDriverRecipientIds.length,
        successCount,
        errorCount,
        userFetchDurationMs,
        payloadAssemblyDurationMs,
        pushSendDurationMs,
        duration: `${duration}ms`
      });

      return null;

    } catch (error) {
      const duration = Date.now() - startTime;
      log.error("Fatal error in sendItineraryNotification", error, { tourId, duration: `${duration}ms` });
      return null;
    }
  }
);

/**
 * Derives one privacy-safe semantic change record from a published Driver Tour
 * Pack revision and notifies only coherently assigned drivers. Publication
 * metadata is excluded by the pure change summarizer, so identical/no-op
 * republishes never create a notice or push.
 */
exports.sendDriverTourPackChangeNotification = onValueWritten(
  {
    ref: '/driver_tour_packs/{departureKey}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
  },
  async (event) => {
    const departureKey = event.params.departureKey;
    const beforePack = event.data?.before?.val?.() || null;
    const afterPack = event.data?.after?.val?.() || null;
    if (!isValidFirebaseKey(departureKey) || afterPack?.departureKey !== departureKey) {
      log.warn('Driver Tour Pack change trigger rejected invalid identity', { departureKey });
      return null;
    }

    const change = summarizeDriverTourPackChange(beforePack, afterPack, {
      eventId: event.id,
      createdAtMs: Date.now(),
    });
    if (!change) {
      log.info('Skipping metadata-only Driver Tour Pack notification', { departureKey });
      return null;
    }

    const db = admin.database();
    const changePath = `driver_tour_pack_changes/${departureKey}/latest`;
    const safeChange = {
      ...change,
      changedSections: Object.fromEntries(change.changedSections.map((section) => [section, true])),
      notificationStatus: 'processing',
      notificationUpdatedAtMs: Date.now(),
    };

    try {
      await db.ref(changePath).set(safeChange);
      const [manifestSnapshot, featureFlagsSnapshot] = await Promise.all([
        db.ref(`tour_manifests/${afterPack.tourId}`).once('value'),
        db.ref('driver_tour_pack_feature_flags').once('value'),
      ]);
      const manifestData = manifestSnapshot.val() || {};
      const featureFlags = featureFlagsSnapshot.val() || {};
      const globalNotificationsEnabled = featureFlags.global === true;
      const enabledDriverFlags = featureFlags.drivers && typeof featureFlags.drivers === 'object'
        ? featureFlags.drivers
        : {};
      const notificationManifest = globalNotificationsEnabled
        ? manifestData
        : {
          ...manifestData,
          assigned_drivers: Object.fromEntries(Object.entries(manifestData.assigned_drivers || {})
            .filter(([driverId, assigned]) => assigned === true && enabledDriverFlags[driverId] === true)),
        };
      const recipientIds = await resolveAssignedDriverRecipientIds({
        tourId: afterPack.tourId,
        manifestData: notificationManifest,
        context: { departureKey, notificationType: 'driver_tour_pack' },
      });
      const activeRecipientIds = await filterOperationalRecipientsByActiveSession({
        recipientIds,
        tourId: afterPack.tourId,
      });
      const cappedRecipientIds = applyRecipientCap(activeRecipientIds, NOTIFICATION_RECIPIENT_CAP, {
        departureKey,
        notificationType: 'driver_tour_pack',
      });
      const usersMap = await fetchUsersSnapshot(cappedRecipientIds, {
        departureKey,
        notificationType: 'driver_tour_pack',
      });
      const { validRecipients, invalidTokens } = selectNotificationRecipients({
        participantIds: cappedRecipientIds,
        usersMap,
        preferencePath: ['preferences', 'ops', 'driver_updates'],
        senderId: null,
        excludeSender: false,
        context: { departureKey, notificationType: 'driver_tour_pack' },
      });
      if (invalidTokens.length) await cleanupInvalidTokens(invalidTokens);

      const title = 'Operational information changed';
      const body = change.critical
        ? 'A critical operational update requires your acknowledgement in the Driver Command Centre.'
        : 'Open the Driver Command Centre to review the updated sections.';
      const notice = buildTourNotificationRecord({
        type: 'driver_tour_pack',
        tourId: afterPack.tourId,
        sourceId: `${departureKey}:${afterPack.revision}`,
        title,
        body,
        screen: 'DriverTourPack',
        createdAtMs: change.createdAtMs,
        priority: change.critical ? 'high' : 'normal',
        departureKey,
        revision: afterPack.revision,
        changedSections: change.changedSections,
        critical: change.critical,
        requiresAcknowledgement: change.requiresAcknowledgement,
      });
      // Driver Tour Pack notices live in the exact-assignment change root. They
      // are deliberately not copied into the tour-wide passenger inbox.

      const pushMessages = validRecipients.map(({ userData }) => ({
        to: userData.pushToken,
        sound: 'default',
        title,
        body,
        data: buildPushNavigationData({
          screen: 'DriverTourPack',
          tourId: afterPack.tourId,
          noticeId: notice.noticeId,
          notificationType: 'driver_tour_pack',
          departureKey,
          revision: afterPack.revision,
          changedSections: change.changedSections,
          critical: change.critical,
          requiresAcknowledgement: change.requiresAcknowledgement,
        }),
        priority: change.critical ? 'high' : 'default',
        channelId: 'default',
      }));

      let successCount = 0;
      let errorCount = 0;
      const expo = getExpoPushClient();
      for (const chunk of expo.chunkPushNotifications(pushMessages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          tickets.forEach((ticket) => {
            if (ticket?.status === 'ok') successCount += 1;
            else errorCount += 1;
          });
          const tokenFailures = collectExpoTokenFailures(tickets, chunk);
          if (tokenFailures.length) {
            await Promise.all(tokenFailures.map(async ({ token, errorCode }) => {
              const recipient = validRecipients.find((candidate) => candidate.userData?.pushToken === token);
              if (recipient?.userId) await removeInvalidToken(recipient.userId, token, { reason: errorCode });
            }));
          }
        } catch (error) {
          errorCount += chunk.length;
          log.error('Driver Tour Pack notification chunk failed', error, { departureKey, chunkSize: chunk.length });
        }
      }

      await db.ref(changePath).update({
        notificationStatus: pushMessages.length === 0
          ? (globalNotificationsEnabled || Object.values(enabledDriverFlags).some((enabled) => enabled === true)
            ? 'no_recipients'
            : 'feature_disabled')
          : errorCount === 0 ? 'delivered' : successCount > 0 ? 'partial' : 'failed',
        notificationRecipientCount: pushMessages.length,
        notificationSuccessCount: successCount,
        notificationErrorCount: errorCount,
        notificationUpdatedAtMs: Date.now(),
        noticeId: notice.noticeId,
      });
      log.info('Driver Tour Pack semantic notification completed', {
        departureKey,
        revision: afterPack.revision,
        changedSections: change.changedSections,
        critical: change.critical,
        recipientCount: pushMessages.length,
        successCount,
        errorCount,
      });
    } catch (error) {
      await db.ref(changePath).update({
        notificationStatus: 'failed',
        notificationUpdatedAtMs: Date.now(),
      }).catch(() => {});
      log.error('Driver Tour Pack semantic notification failed', error, {
        departureKey,
        revision: afterPack.revision,
      });
    }
    return null;
  },
);

exports.processNotificationReadMigrationRequest = onValueCreated(
  {
    ref: '/notification_read_migration_requests/{tourId}/{authUid}',
    region: 'europe-west1',
    instance: 'loch-lomond-travel-default-rtdb',
    maxInstances: 10,
    retry: true,
  },
  async (event) => {
    const { tourId, authUid } = event.params;
    try {
      const result = await processNotificationReadMigrationRequest({
        db: admin.database(),
        tourId,
        authUid,
        request: event.data?.val(),
      });
      log.info('Notification read-state migration request completed', {
        tourId,
        legacyRemoved: result.legacyRemoved,
        invalid: result.invalid,
      });
      return result;
    } catch (error) {
      log.error('Notification read-state migration request failed', error, { tourId, authUid });
      throw error;
    }
  },
);

/**
 * Continues exact notice read-state cleanup in bounded user pages. Eviction
 * only enqueues a small durable job; notification delivery never downloads a
 * tour-wide read-state fanout.
 */
exports.cleanupNotificationReadState = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const database = admin.database();
    const results = await processNotificationReadCleanupJobs({ db: database });
    let legacyResult = null;
    try {
      legacyResult = await processLegacyNotificationReadStateCleanup({ db: database });
    } catch (error) {
      log.warn('Legacy notification read-state cleanup deferred', {
        error: error?.message || String(error),
      });
    }
    log.info('Notification read-state cleanup pass completed', {
      jobCount: results.length,
      completedCount: results.filter((result) => result.completed).length,
      deferredCount: results.filter((result) => result.error).length,
      legacyProcessedCount: legacyResult?.processedCount || 0,
      legacyDeletedCount: legacyResult?.deletedCount || 0,
      legacyCompleted: legacyResult?.completed === true,
    });
    return { jobs: results, legacy: legacyResult };
  },
);

/**
 * Private cross-project boundary for management-generated Driver Tour Packs.
 * Cloud Run IAM and a second in-process Google OIDC check both restrict the
 * caller to the management sync service account.
 */
Object.assign(exports, tourIndexFunctions, scheduledCleanupFunctions, {
  createGroupPhotoChatMessage,
  deleteGroupPhoto,
  resolveGroupPhotoMedia,
  uploadGroupPhoto,
  deletePrivatePhoto,
  ingestDriverTourPacks,
  resolvePrivatePhotoMedia,
  uploadPrivatePhoto,
});

exports.__testables = {
  toRealtimeKeySegment,
  validateMessageData,
  buildChatNotificationContent,
  buildSafetyNotificationContent,
  normalizeSafetySubmissionInput,
  buildCanonicalSafetyRecord,
  buildSafetySubmissionUpdates,
  resolveSafetyReporterAccess,
  checkSafetySubmissionRateLimit,
  resolveChatSenderParticipantIds,
  resolveChatSenderDeliveryIds,
  collectAssignedDriverIds,
  isDriverProfileAssignedToTour,
  resolveAssignedDriverRecipientIds,
  getPushTokenIneligibilityReason,
  shouldRemoveInvalidToken,
  cleanupInvalidTokens,
  selectNotificationRecipients,
  parseSourcePhotoPath,
  buildPhotoCollectionPath,
  processPhotoVariantObject,
  findPhotoRecordByStoragePath,
  isPhotoVariantRecordReady,
  hardenPrivateSourceObjectMetadata,
  hardenGroupSourceObjectMetadata,
  createPhotoVariantBuffers,
  buildPhotoVariantPaths,
  generatePhotoVariantsForRecord,
  sanitizeLogText,
  buildVerifiedLoginGrantUpdates,
  buildPassengerIdentitySecurityUpdates,
  authorizePassengerLoginDevice,
  ensureOpaquePassengerIdentity,
  isOpaquePassengerId,
  buildPassengerSafeItinerary,
  buildPassengerSafeBooking,
  buildPassengerSafeTour,
  verifyRequestAuthUid,
  verifyCurrentTourPhotoAccess,
  enforceGroupMediaAppCheck,
  normalizeGroupMediaRequest,
  isGroupMediaPathForRecord,
  readGroupMediaRecords,
  signGroupMediaRecords,
  normalizeGroupPhotoUploadMetadata,
  extensionForGroupPhotoContentType,
  reserveGroupPhotoRecord,
  normalizeManualPassengerPayload,
  findManualPassengerSeatConflicts,
  buildManualPassengerBookingUpdates,
  verifyOperationsAdminAccess,
  isAllowedAdminOrigin,
  buildTourManifestPayload,
  verifyTourManifestAccess,
  normalizeManifestPassengerRows,
  normalizeManifestBooking,
  buildDriverManifestBooking,
  resolveDriverAssignment,
  claimDriverAuthUid,
  buildDriverIdentityProfileUpdates,
  collectDriverAssignmentConflicts,
  buildDriverSelfAssignmentUpdates,
  checkDriverLoginRateLimits,
  validateCategoryBroadcastData,
  userWantsTourCategoryBroadcast,
  resolveBroadcastDeliveryStatus,
  buildTourDeletionUpdates,
  resolveReportedPhotoStoragePaths,
  checkPassengerLoginRateLimits,
  shouldRequireLoginAppCheck,
  isDeployedFunctionsRuntime,
  enforceLoginAppCheck,
  getTrustedRequestNetworkKey,
  createDistributedLoginRateLimiter,
  cleanupExpiredLoginRateLimits,
  buildTourNotificationId,
  buildTourNotificationRecord,
  buildPushNavigationData,
  buildCategoryBroadcastPushMessages,
  summarizeItineraryChange,
  summarizeDriverTourPackChange,
  buildDriverTourPackActionProjectionUpdates,
  persistTourNotification,
  buildNotificationReadCleanupJobId,
  enqueueNotificationReadCleanupJobs,
  processNotificationReadMigrationRequest,
  fetchRealtimeDatabaseShallowKeys,
  shouldDeleteLegacyNotificationReadPrincipal,
  processLegacyNotificationReadStateCleanup,
  processNotificationReadCleanupJob,
  processNotificationReadCleanupJobs,
  createDriverTourPackPublisher,
  validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest,
  normalizePrivateMediaRequest,
  isPrivateMediaPathForRecord,
  readPrivateMediaRecords,
  signPrivateMediaRecords,
  buildDriverSessionRecord,
  buildPassengerParticipantRecord,
  buildPassengerSessionRecord,
  calculateSessionExpiry,
  createAppSessionId,
  isActiveSessionRecord,
  isValidAppSessionId,
  toClientSession,
  acquireAppSessionLock,
  releaseAppSessionLock,
  verifyActiveAppSession,
  buildAppSessionCleanupUpdates,
  buildAppSessionEvent,
  cleanupAppSession,
  cleanupDriverLocationForSession,
  normalizePrivatePhotoUploadMetadata,
  reservePrivatePhotoRecord,
};
