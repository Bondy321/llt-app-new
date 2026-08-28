'use strict';

const { loadLegacyLibrary } = require('./bootstrap/legacyLibrary');
const { createPhotoVariantBuffers } = require('./infrastructure/storage/mediaProcessor');
const { sanitizeLogText } = require('./infrastructure/logging/safeLogger');
const { verifyRequestAuthUid } = require('./infrastructure/auth/requestAuth');
const { enforceLoginAppCheck, shouldRequireLoginAppCheck } = require('./infrastructure/auth/loginAppCheckGate');
const { isAllowedAdminOrigin } = require('./infrastructure/http/adminCors');
const { isDeployedFunctionsRuntime } = require('./config/runtimeConfig');
const { enforceGroupMediaAppCheck } = require('./infrastructure/auth/appCheckGate');
const notificationPolicy = require('./domains/notifications/notificationPolicy');
const notificationRecipients = require('./domains/notifications/notificationRecipients');
const notificationDelivery = require('./domains/notifications/notificationDelivery');
const groupMediaFunctions = require('./domains/media/groupMediaFunctions');
const notificationState = require('./domains/notifications/notificationState');
const notificationDeliveryPolicy = require('./domains/notifications/notificationDeliveryPolicy');
const notificationJobs = require('./domains/notifications/notificationJobs');
const notificationAudiencePage = require('./domains/notifications/notificationAudiencePage');
const notificationWorker = require('./domains/notifications/notificationWorker');
const expoRequestErrorClassifier = require('./domains/notifications/expoRequestErrorClassifier');
const notificationReceipts = require('./domains/notifications/notificationReceipts');
const notificationProducerJobs = require('./domains/notifications/notificationProducerJobs');
const notificationAdminFunctions = require('./domains/notifications/notificationAdminFunctions');
const notificationDeviceFunctions = require('./domains/notifications/notificationDeviceFunctions');
const { cleanupInvalidTokens } = require('./domains/notifications/invalidTokenCleanup');
const broadcastFunctions = require('./domains/notifications/broadcastFunctions');
const photoVariants = require('./domains/media/photoVariants');
const photoVariantFunction = require('./domains/media/photoVariantFunction');
const mediaAccess = require('./domains/media/mediaAccess');
const privateMediaFunctions = require('./domains/media/privateMediaFunctions');
const safetySubmission = require('./domains/safety/safetySubmission');
const { resolveSafetyReporterAccess } = require('./domains/safety/safetyAccess');
const { checkSafetySubmissionRateLimit } = require('./domains/safety/safetyRateLimit');
const sessionIssuance = require('./domains/app-sessions/sessionIssuance');
const roleTransition = require('./domains/app-sessions/roleTransition');
const passengerProjection = require('./domains/passenger-auth/passengerProjection');
const passengerLoginWorkflow = require('./domains/passenger-auth/passengerLoginWorkflow');
const passengerLoginSecurity = require('./domains/passenger-auth/passengerLoginSecurity');
const driverLoginSecurity = require('./domains/driver-auth/driverLoginSecurity');
const driverDevicePolicy = require('./domains/driver-auth/driverDevicePolicy');
const driverDevicePolicyFunctions = require('./domains/driver-auth/driverDevicePolicyFunctions');
const manualPassengerBooking = require('./domains/administration/manualPassengerBooking');
const { verifyOperationsAdminAccess } = require('./domains/administration/public');
const tourDeletion = require('./domains/administration/tourDeletion');
const manifestDomain = require('./domains/manifests/manifestDomain');
const driverAssignment = require('./domains/driver-assignment/driverAssignment');

const passengerIdentity = loadLegacyLibrary('passengerIdentity');
const loginRateLimiter = loadLegacyLibrary('loginRateLimiter');
const driverTourPackOperations = loadLegacyLibrary('driverTourPackOperations');
const driverTourPackPublisher = loadLegacyLibrary('driverTourPackPublisher');
const managementOidc = loadLegacyLibrary('managementOidc');
const manifestPassengers = loadLegacyLibrary('manifestPassengers');
const appSession = loadLegacyLibrary('appSession');
const appSessionLock = loadLegacyLibrary('appSessionLock');
const appSessionAccess = loadLegacyLibrary('appSessionAccess');
const appSessionCleanup = loadLegacyLibrary('appSessionCleanup');
const chatPresenceProjection = loadLegacyLibrary('chatPresenceProjection');
const driverLocationProjection = loadLegacyLibrary('driverLocationProjection');

module.exports = {
  buildGroupPhotoChatMessageRecord: groupMediaFunctions.buildGroupPhotoChatMessageRecord,
  buildGroupPhotoChatResponseMessage: groupMediaFunctions.buildGroupPhotoChatResponseMessage,
  toRealtimeKeySegment: notificationPolicy.toRealtimeKeySegment,
  validateMessageData: notificationPolicy.validateMessageData,
  NOTIFICATION_TYPES: notificationDeliveryPolicy.NOTIFICATION_TYPES,
  CHANNELS: notificationDeliveryPolicy.CHANNELS,
  SAFE_NOTIFICATION_STATUSES: notificationDeliveryPolicy.SAFE_NOTIFICATION_STATUSES,
  getNotificationDeliveryPolicy: notificationDeliveryPolicy.getNotificationDeliveryPolicy,
  buildDeliveryGrouping: notificationDeliveryPolicy.buildDeliveryGrouping,
  buildNotificationJobId: notificationJobs.buildNotificationJobId,
  createNotificationJobRecord: notificationJobs.createNotificationJobRecord,
  enqueueNotificationJob: notificationJobs.enqueueNotificationJob,
  calculateNotificationRetryDelayMs: notificationJobs.calculateRetryDelayMs,
  acquireNotificationJobLease: notificationJobs.acquireNotificationJobLease,
  loadNotificationAudiencePage: notificationAudiencePage.loadNotificationAudiencePage,
  normalizeNotificationDevice: notificationAudiencePage.normalizeNotificationDevice,
  evaluateNotificationAudienceCandidate: notificationAudiencePage.evaluateAudienceCandidate,
  hashNotificationPushToken: notificationAudiencePage.hashPushToken,
  buildNotificationDeliveryAttemptId: notificationWorker.buildDeliveryAttemptId,
  buildNotificationExpoPushMessage: notificationWorker.buildExpoPushMessage,
  buildNotificationAudiencePageId: notificationWorker.buildAudiencePageId,
  classifyExpoRequestError: expoRequestErrorClassifier.classifyExpoRequestError,
  commitNotificationAudiencePage: notificationWorker.commitNotificationAudiencePage,
  handleExpoRequestFailure: notificationWorker.handleExpoRequestFailure,
  persistNotificationTicketResult: notificationWorker.persistTicketResult,
  processNotificationJobPage: notificationWorker.processNotificationJobPage,
  runNotificationJob: notificationWorker.runNotificationJob,
  refreshNotificationJobStatus: notificationReceipts.refreshNotificationJobStatus,
  compareAndClearNotificationTokenByHash: notificationReceipts.compareAndClearTokenByHash,
  processDueNotificationReceipts: notificationReceipts.processDueNotificationReceipts,
  retryDueNotificationAttempts: notificationReceipts.retryDueNotificationAttempts,
  STALE_SENDING_ATTEMPT_MS: notificationReceipts.STALE_SENDING_ATTEMPT_MS,
  buildChatNotificationJob: notificationProducerJobs.buildChatNotificationJob,
  buildSafetyNotificationJob: notificationProducerJobs.buildSafetyNotificationJob,
  buildNotificationPreviewJob: notificationAdminFunctions.buildPreviewJob,
  requeueFailedNotificationJob: notificationAdminFunctions.requeueFailedNotificationJob,
  readSafetyAlertDetail: notificationDeviceFunctions.readSafetyAlertDetail,
  updateSafetyAlertStatus: notificationDeviceFunctions.updateSafetyAlertStatus,
  buildChatNotificationContent: notificationPolicy.buildChatNotificationContent,
  buildSafetyNotificationContent: notificationPolicy.buildSafetyNotificationContent,
  normalizeSafetySubmissionInput: safetySubmission.normalizeSafetySubmissionInput,
  buildCanonicalSafetyRecord: safetySubmission.buildCanonicalSafetyRecord,
  buildSafetySubmissionUpdates: safetySubmission.buildSafetySubmissionUpdates,
  resolveSafetyReporterAccess,
  checkSafetySubmissionRateLimit,
  resolveChatSenderParticipantIds: notificationRecipients.resolveChatSenderParticipantIds,
  resolveChatSenderDeliveryIds: notificationDelivery.resolveChatSenderDeliveryIds,
  collectAssignedDriverIds: notificationRecipients.collectAssignedDriverIds,
  isDriverProfileAssignedToTour: notificationRecipients.isDriverProfileAssignedToTour,
  resolveAssignedDriverRecipientIds: notificationDelivery.resolveAssignedDriverRecipientIds,
  loadDriverSessionAuthUids: notificationDelivery.loadDriverSessionAuthUids,
  getPushTokenIneligibilityReason: notificationPolicy.getPushTokenIneligibilityReason,
  shouldRemoveInvalidToken: notificationPolicy.shouldRemoveInvalidToken,
  cleanupInvalidTokens,
  selectNotificationRecipients: notificationRecipients.selectNotificationRecipients,
  parseSourcePhotoPath: photoVariants.parseSourcePhotoPath,
  buildPhotoCollectionPath: photoVariants.buildPhotoCollectionPath,
  processPhotoVariantObject: photoVariantFunction.processPhotoVariantObject,
  findPhotoRecordByStoragePath: photoVariantFunction.findPhotoRecordByStoragePath,
  isPhotoVariantRecordReady: photoVariantFunction.isPhotoVariantRecordReady,
  hardenPrivateSourceObjectMetadata: photoVariants.hardenPrivateSourceObjectMetadata,
  hardenGroupSourceObjectMetadata: photoVariants.hardenGroupSourceObjectMetadata,
  createPhotoVariantBuffers,
  buildPhotoVariantPaths: photoVariants.buildPhotoVariantPaths,
  generatePhotoVariantsForRecord: photoVariants.generatePhotoVariantsForRecord,
  sanitizeLogText,
  buildVerifiedLoginGrantUpdates: sessionIssuance.buildVerifiedLoginGrantUpdates,
  buildPassengerIdentitySecurityUpdates: passengerIdentity.buildPassengerIdentitySecurityUpdates,
  authorizePassengerLoginDevice: passengerIdentity.authorizePassengerLoginDevice,
  ensureOpaquePassengerIdentity: passengerIdentity.ensureOpaquePassengerIdentity,
  isOpaquePassengerId: passengerIdentity.isOpaquePassengerId,
  buildPassengerSafeItinerary: passengerProjection.buildPassengerSafeItinerary,
  buildPassengerSafeBooking: passengerProjection.buildPassengerSafeBooking,
  buildPassengerSafeTour: passengerProjection.buildPassengerSafeTour,
  buildPassengerLoginResponse: passengerLoginWorkflow.buildPassengerLoginResponse,
  buildPassengerCustomClaims: passengerLoginWorkflow.buildPassengerCustomClaims,
  buildPassengerRoleClaimJob: roleTransition.buildPassengerRoleClaimJob,
  processPassengerRoleClaimJobs: roleTransition.processPassengerRoleClaimJobs,
  reconcilePassengerRoleClaimJob: roleTransition.reconcilePassengerRoleClaimJob,
  verifyRequestAuthUid,
  verifyCurrentTourPhotoAccess: mediaAccess.verifyCurrentTourPhotoAccess,
  enforceGroupMediaAppCheck,
  normalizeGroupMediaRequest: mediaAccess.normalizeGroupMediaRequest,
  isGroupMediaPathForRecord: mediaAccess.isGroupMediaPathForRecord,
  readGroupMediaRecords: mediaAccess.readGroupMediaRecords,
  signGroupMediaRecords: mediaAccess.signGroupMediaRecords,
  normalizeGroupPhotoUploadMetadata: groupMediaFunctions.normalizeGroupPhotoUploadMetadata,
  extensionForGroupPhotoContentType: groupMediaFunctions.extensionForGroupPhotoContentType,
  reserveGroupPhotoRecord: groupMediaFunctions.reserveGroupPhotoRecord,
  normalizeManualPassengerPayload: manualPassengerBooking.normalizeManualPassengerPayload,
  findManualPassengerSeatConflicts: manualPassengerBooking.findManualPassengerSeatConflicts,
  buildManualPassengerBookingUpdates: manualPassengerBooking.buildManualPassengerBookingUpdates,
  verifyOperationsAdminAccess,
  isAllowedAdminOrigin,
  buildTourManifestPayload: manifestDomain.buildTourManifestPayload,
  verifyTourManifestAccess: manifestDomain.verifyTourManifestAccess,
  normalizeManifestPassengerRows: manifestPassengers.normalizeManifestPassengerRows,
  normalizeManifestBooking: manifestDomain.normalizeManifestBooking,
  buildDriverManifestBooking: manifestDomain.buildDriverManifestBooking,
  resolveDriverAssignment: driverAssignment.resolveDriverAssignment,
  claimDriverAuthUid: driverAssignment.claimDriverAuthUid,
  buildDriverIdentityProfileUpdates: driverAssignment.buildDriverIdentityProfileUpdates,
  collectDriverAssignmentConflicts: driverAssignment.collectDriverAssignmentConflicts,
  buildDriverSelfAssignmentUpdates: driverAssignment.buildDriverSelfAssignmentUpdates,
  checkDriverLoginRateLimits: driverLoginSecurity.checkDriverLoginRateLimits,
  normalizeDriverLoginPolicy: driverDevicePolicy.normalizeDriverLoginPolicy,
  driverBindingAllowedByPolicy: driverDevicePolicy.driverBindingAllowedByPolicy,
  driverSessionMatchesPolicyGeneration: driverDevicePolicy.driverSessionMatchesPolicyGeneration,
  ensureDriverLoginPolicy: driverDevicePolicy.ensureDriverLoginPolicy,
  buildDriverLoginPolicyTransitionUpdates: driverDevicePolicyFunctions.buildPolicyTransitionUpdates,
  cleanupExpiredDriverPolicyRecords: driverDevicePolicyFunctions.cleanupExpiredDriverPolicyRecords,
  countDriverLoginPolicyCleanupJobs: driverDevicePolicyFunctions.countPolicyCleanupJobs,
  processDriverLoginPolicyCleanupJobs: driverDevicePolicyFunctions.processDriverLoginPolicyCleanupJobs,
  validateCategoryBroadcastData: broadcastFunctions.validateCategoryBroadcastData,
  userWantsTourCategoryBroadcast: notificationPolicy.userWantsTourCategoryBroadcast,
  resolveBroadcastDeliveryStatus: broadcastFunctions.resolveBroadcastDeliveryStatus,
  buildTourDeletionUpdates: tourDeletion.buildTourDeletionUpdates,
  resolveReportedPhotoStoragePaths: tourDeletion.resolveReportedPhotoStoragePaths,
  checkPassengerLoginRateLimits: passengerLoginSecurity.checkPassengerLoginRateLimits,
  shouldRequireLoginAppCheck,
  isDeployedFunctionsRuntime,
  enforceLoginAppCheck,
  getTrustedRequestNetworkKey: passengerLoginSecurity.getTrustedRequestNetworkKey,
  createDistributedLoginRateLimiter: loginRateLimiter.createDistributedLoginRateLimiter,
  cleanupExpiredLoginRateLimits: loginRateLimiter.cleanupExpiredLoginRateLimits,
  buildTourNotificationId: notificationState.buildTourNotificationId,
  buildTourNotificationRecord: notificationState.buildTourNotificationRecord,
  buildPushNavigationData: notificationState.buildPushNavigationData,
  buildCategoryBroadcastPushMessages: notificationDelivery.buildCategoryBroadcastPushMessages,
  summarizeItineraryChange: notificationState.summarizeItineraryChange,
  summarizeDriverTourPackChange: driverTourPackOperations.summarizeDriverTourPackChange,
  buildDriverTourPackActionProjectionUpdates: driverTourPackOperations.buildDriverTourPackActionProjectionUpdates,
  persistTourNotification: notificationState.persistTourNotification,
  buildNotificationReadCleanupJobId: notificationState.buildNotificationReadCleanupJobId,
  enqueueNotificationReadCleanupJobs: notificationState.enqueueNotificationReadCleanupJobs,
  processNotificationReadMigrationRequest: notificationState.processNotificationReadMigrationRequest,
  fetchRealtimeDatabaseShallowKeys: notificationState.fetchRealtimeDatabaseShallowKeys,
  shouldDeleteLegacyNotificationReadPrincipal: notificationState.shouldDeleteLegacyNotificationReadPrincipal,
  processLegacyNotificationReadStateCleanup: notificationState.processLegacyNotificationReadStateCleanup,
  processNotificationReadCleanupJob: notificationState.processNotificationReadCleanupJob,
  processNotificationReadCleanupJobs: notificationState.processNotificationReadCleanupJobs,
  createDriverTourPackPublisher: driverTourPackPublisher.createDriverTourPackPublisher,
  validateDriverTourPackHttpRequest: managementOidc.validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest: managementOidc.verifyManagementOidcRequest,
  normalizePrivateMediaRequest: mediaAccess.normalizePrivateMediaRequest,
  isPrivateMediaPathForRecord: mediaAccess.isPrivateMediaPathForRecord,
  readPrivateMediaRecords: mediaAccess.readPrivateMediaRecords,
  signPrivateMediaRecords: mediaAccess.signPrivateMediaRecords,
  buildDriverSessionRecord: appSession.buildDriverSessionRecord,
  buildPassengerParticipantRecord: appSession.buildPassengerParticipantRecord,
  buildPassengerSessionRecord: appSession.buildPassengerSessionRecord,
  calculateSessionExpiry: appSession.calculateSessionExpiry,
  createAppSessionId: appSession.createAppSessionId,
  isActiveSessionRecord: appSession.isActiveSessionRecord,
  isValidAppSessionId: appSession.isValidAppSessionId,
  toClientSession: appSession.toClientSession,
  acquireAppSessionLock: appSessionLock.acquireAppSessionLock,
  releaseAppSessionLock: appSessionLock.releaseAppSessionLock,
  verifyActiveAppSession: appSessionAccess.verifyActiveAppSession,
  buildAppSessionCleanupUpdates: appSessionCleanup.buildAppSessionCleanupUpdates,
  buildAppSessionEvent: appSessionCleanup.buildAppSessionEvent,
  cleanupAppSession: appSessionCleanup.cleanupAppSession,
  cleanupDriverLocationForSession: appSessionCleanup.cleanupDriverLocationForSession,
  buildDriverLocationProjection: driverLocationProjection.buildDriverLocationProjection,
  cleanupDriverLocationsForAppSession: driverLocationProjection.cleanupDriverLocationsForAppSession,
  reconcileDriverLocationProjection: driverLocationProjection.reconcileDriverLocationProjection,
  buildChatStatusProjection: chatPresenceProjection.buildChatStatusProjection,
  cleanupChatStatusForAppSession: chatPresenceProjection.cleanupChatStatusForAppSession,
  cleanupExpiredChatStatusSessions: chatPresenceProjection.cleanupExpiredChatStatusSessions,
  reconcileChatActorStatus: chatPresenceProjection.reconcileChatActorStatus,
  normalizePrivatePhotoUploadMetadata: privateMediaFunctions.normalizePrivatePhotoUploadMetadata,
  reservePrivatePhotoRecord: privateMediaFunctions.reservePrivatePhotoRecord,
};
