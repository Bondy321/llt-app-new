'use strict';

const administration = require('./domains/administration/administrationFunctions');
const adminDashboard = require('./domains/admin-dashboard/dashboardProjectionFunctions');
const accountDeletion = require('./domains/account-deletion/accountDeletionFunctions');
const sessions = require('./domains/app-sessions/sessionFunctions');
const roleTransitionClaims = require('./domains/app-sessions/roleTransitionClaimFunctions');
const assignment = require('./domains/driver-assignment/driverAssignmentFunction');
const driverAuth = require('./domains/driver-auth/driverLoginFunction');
const driverDevicePolicy = require('./domains/driver-auth/driverDevicePolicyFunctions');
const driverTourPacks = require('./domains/driver-tour-packs/ingestionFunction');
const liveState = require('./domains/live-state/liveStateFunctions');
const liveStateRollout = require('./domains/live-state/liveStateRolloutFunctions');
const driverLocationPickup = require('./domains/live-state/driverLocationPickupFunctions');
const scheduledCleanup = require('./domains/maintenance/scheduledCleanupFunctions');
const tourIndexes = require('./domains/maintenance/tourIndexFunctions');
const manifests = require('./domains/manifests/manifestFunction');
const groupMedia = require('./domains/media/groupMediaFunctions');
const photoVariants = require('./domains/media/photoVariantFunction');
const privateMedia = require('./domains/media/privateMediaFunctions');
const broadcasts = require('./domains/notifications/broadcastFunctions');
const chatNotifications = require('./domains/notifications/chatNotificationFunctions');
const driverTourPackNotifications = require('./domains/notifications/driverTourPackNotificationFunction');
const itineraryNotifications = require('./domains/notifications/itineraryNotificationFunction');
const notificationReads = require('./domains/notifications/notificationReadFunctions');
const notificationWorker = require('./domains/notifications/notificationWorker');
const notificationReceipts = require('./domains/notifications/notificationReceipts');
const notificationDevices = require('./domains/notifications/notificationDeviceFunctions');
const notificationAdmin = require('./domains/notifications/notificationAdminFunctions');
const notificationMarketingAudience = require('./domains/notifications/notificationMarketingAudienceProjection');
const safetyNotifications = require('./domains/notifications/safetyNotificationFunction');
const passengerAuth = require('./domains/passenger-auth/passengerLoginFunction');
const safety = require('./domains/safety/safetyFunction');
const testableRegistry = require('./testableRegistry');

module.exports = {
  __testables: testableRegistry,
  getAccountDeletionStatus: accountDeletion.getAccountDeletionStatus,
  projectDashboardDriver: adminDashboard.projectDashboardDriver,
  projectDashboardManifestAssignment: adminDashboard.projectDashboardManifestAssignment,
  projectDashboardManifestAssignmentCode: adminDashboard.projectDashboardManifestAssignmentCode,
  projectDashboardManifestBooking: adminDashboard.projectDashboardManifestBooking,
  projectDashboardParticipant: adminDashboard.projectDashboardParticipant,
  projectDashboardRecentBroadcast: adminDashboard.projectDashboardRecentBroadcast,
  projectDashboardSafetyAttention: adminDashboard.projectDashboardSafetyAttention,
  projectDashboardTourActive: adminDashboard.projectDashboardTourActive,
  projectDashboardTourAssignmentRevision: adminDashboard.projectDashboardTourAssignmentRevision,
  projectDashboardTourCapacity: adminDashboard.projectDashboardTourCapacity,
  projectDashboardTourCode: adminDashboard.projectDashboardTourCode,
  projectDashboardTourCreated: adminDashboard.projectDashboardTourCreated,
  projectDashboardTourDeleted: adminDashboard.projectDashboardTourDeleted,
  projectDashboardTourDriverName: adminDashboard.projectDashboardTourDriverName,
  projectDashboardTourEndIndex: adminDashboard.projectDashboardTourEndIndex,
  projectDashboardTourName: adminDashboard.projectDashboardTourName,
  projectDashboardTourPassengerScalar: adminDashboard.projectDashboardTourPassengerScalar,
  projectDashboardTourStartDate: adminDashboard.projectDashboardTourStartDate,
  projectDashboardTourStartIndex: adminDashboard.projectDashboardTourStartIndex,
  refreshDashboardTimeWindows: adminDashboard.refreshDashboardTimeWindowsScheduled,
  projectNotificationMarketingAudienceConsent: notificationMarketingAudience.projectNotificationMarketingAudienceOnConsentWrite,
  projectNotificationMarketingAudience: notificationMarketingAudience.projectNotificationMarketingAudienceOnDeviceWrite,
  processAccountDeletionJobs: accountDeletion.processAccountDeletionJobs,
  requestAccountDeletion: accountDeletion.requestAccountDeletion,
  retryAccountDeletion: accountDeletion.retryAccountDeletion,
  assignDriverToTour: assignment.assignDriverToTour,
  cleanupExpiredAppSessions: scheduledCleanup.cleanupExpiredAppSessions,
  cleanupExpiredChatStatusSessions: liveState.cleanupExpiredChatStatusSessions,
  cleanupExpiredDriverLocations: scheduledCleanup.cleanupExpiredDriverLocations,
  cleanupExpiredDriverTourPacks: scheduledCleanup.cleanupExpiredDriverTourPacks,
  cleanupExpiredLoginRateLimits: scheduledCleanup.cleanupExpiredLoginRateLimits,
  cleanupDriverLoginPolicySessions: driverDevicePolicy.cleanupDriverLoginPolicySessions,
  cleanupNotificationReadState: notificationReads.cleanupNotificationReadState,
  cleanupNotificationDeliveryData: notificationReceipts.cleanupNotificationDeliveryData,
  createGroupPhotoChatMessage: groupMedia.createGroupPhotoChatMessage,
  createManualPassengerBooking: administration.createManualPassengerBooking,
  deleteGroupPhoto: groupMedia.deleteGroupPhoto,
  deletePrivatePhoto: privateMedia.deletePrivatePhoto,
  deleteTourData: administration.deleteTourData,
  endAppSession: sessions.endAppSession,
  generatePhotoVariants: photoVariants.generatePhotoVariants,
  getTourManifest: manifests.getTourManifest,
  getMarketingNotificationDetail: notificationDevices.getMarketingNotificationDetail,
  getDriverLoginPolicy: driverDevicePolicy.getDriverLoginPolicy,
  getLiveStateRollout: liveStateRollout.getLiveStateRollout,
  getSafetyAlertDetail: notificationDevices.getSafetyAlertDetail,
  ingestDriverTourPacks: driverTourPacks.ingestDriverTourPacks,
  normalizeTourDateIndexes: tourIndexes.normalizeTourDateIndexes,
  normalizeTourEndDateIndex: tourIndexes.normalizeTourEndDateIndex,
  processBroadcastWrite: broadcasts.processBroadcastWrite,
  processCategoryBroadcastWrite: broadcasts.processCategoryBroadcastWrite,
  processNotificationDeliveryJob: notificationWorker.processNotificationDeliveryJob,
  processNotificationReceipts: notificationReceipts.processNotificationReceipts,
  projectChatPresenceSession: liveState.projectChatPresenceSession,
  projectChatTypingSession: liveState.projectChatTypingSession,
  projectDriverLocationPickup: liveState.projectDriverLocationPickup,
  projectDriverLocationSession: liveState.projectDriverLocationSession,
  processNotificationReadMigrationRequest: notificationReads.processNotificationReadMigrationRequest,
  projectDriverTourPackActionState: tourIndexes.projectDriverTourPackActionState,
  removeReportedPhoto: administration.removeReportedPhoto,
  recoverNotificationDeliveryJobs: notificationWorker.recoverNotificationDeliveryJobs,
  requeueNotificationJob: notificationAdmin.requeueNotificationJob,
  resolveGroupPhotoMedia: groupMedia.resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia: privateMedia.resolvePrivatePhotoMedia,
  revokeAppSession: sessions.revokeAppSession,
  reconcilePassengerRoleClaims: roleTransitionClaims.reconcilePassengerRoleClaims,
  sendChatNotification: chatNotifications.sendChatNotification,
  sendDriverTourPackChangeNotification: driverTourPackNotifications.sendDriverTourPackChangeNotification,
  sendInternalChatNotification: chatNotifications.sendInternalChatNotification,
  sendItineraryNotification: itineraryNotifications.sendItineraryNotification,
  sendSafetyAlertNotification: safetyNotifications.sendSafetyAlertNotification,
  setDriverLoginPolicy: driverDevicePolicy.setDriverLoginPolicy,
  setLiveStateRollout: liveStateRollout.setLiveStateRollout,
  submitSafetyReport: safety.submitSafetyReport,
  createServerTestNotification: notificationAdmin.createServerTestNotification,
  previewNotificationAudience: notificationAdmin.previewNotificationAudience,
  updateNotificationDeviceRegistration: notificationDevices.updateNotificationDeviceRegistration,
  updateDriverLocationPickup: driverLocationPickup.updateDriverLocationPickup,
  uploadGroupPhoto: groupMedia.uploadGroupPhoto,
  uploadPrivatePhoto: privateMedia.uploadPrivatePhoto,
  verifyDriverLogin: driverAuth.verifyDriverLogin,
  verifyPassengerLogin: passengerAuth.verifyPassengerLogin,
};
