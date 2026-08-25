'use strict';

const administration = require('./domains/administration/administrationFunctions');
const sessions = require('./domains/app-sessions/sessionFunctions');
const assignment = require('./domains/driver-assignment/driverAssignmentFunction');
const driverAuth = require('./domains/driver-auth/driverLoginFunction');
const driverTourPacks = require('./domains/driver-tour-packs/ingestionFunction');
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
const safetyNotifications = require('./domains/notifications/safetyNotificationFunction');
const passengerAuth = require('./domains/passenger-auth/passengerLoginFunction');
const safety = require('./domains/safety/safetyFunction');
const testableRegistry = require('./testableRegistry');

module.exports = {
  __testables: testableRegistry,
  assignDriverToTour: assignment.assignDriverToTour,
  cleanupExpiredAppSessions: scheduledCleanup.cleanupExpiredAppSessions,
  cleanupExpiredDriverLocations: scheduledCleanup.cleanupExpiredDriverLocations,
  cleanupExpiredDriverTourPacks: scheduledCleanup.cleanupExpiredDriverTourPacks,
  cleanupExpiredLoginRateLimits: scheduledCleanup.cleanupExpiredLoginRateLimits,
  cleanupNotificationReadState: notificationReads.cleanupNotificationReadState,
  createGroupPhotoChatMessage: groupMedia.createGroupPhotoChatMessage,
  createManualPassengerBooking: administration.createManualPassengerBooking,
  deleteGroupPhoto: groupMedia.deleteGroupPhoto,
  deletePrivatePhoto: privateMedia.deletePrivatePhoto,
  deleteTourData: administration.deleteTourData,
  endAppSession: sessions.endAppSession,
  generatePhotoVariants: photoVariants.generatePhotoVariants,
  getTourManifest: manifests.getTourManifest,
  ingestDriverTourPacks: driverTourPacks.ingestDriverTourPacks,
  normalizeTourDateIndexes: tourIndexes.normalizeTourDateIndexes,
  normalizeTourEndDateIndex: tourIndexes.normalizeTourEndDateIndex,
  processBroadcastWrite: broadcasts.processBroadcastWrite,
  processCategoryBroadcastWrite: broadcasts.processCategoryBroadcastWrite,
  processNotificationReadMigrationRequest: notificationReads.processNotificationReadMigrationRequest,
  projectDriverTourPackActionState: tourIndexes.projectDriverTourPackActionState,
  removeReportedPhoto: administration.removeReportedPhoto,
  resolveGroupPhotoMedia: groupMedia.resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia: privateMedia.resolvePrivatePhotoMedia,
  revokeAppSession: sessions.revokeAppSession,
  sendChatNotification: chatNotifications.sendChatNotification,
  sendDriverTourPackChangeNotification: driverTourPackNotifications.sendDriverTourPackChangeNotification,
  sendInternalChatNotification: chatNotifications.sendInternalChatNotification,
  sendItineraryNotification: itineraryNotifications.sendItineraryNotification,
  sendSafetyAlertNotification: safetyNotifications.sendSafetyAlertNotification,
  submitSafetyReport: safety.submitSafetyReport,
  uploadGroupPhoto: groupMedia.uploadGroupPhoto,
  uploadPrivatePhoto: privateMedia.uploadPrivatePhoto,
  verifyDriverLogin: driverAuth.verifyDriverLogin,
  verifyPassengerLogin: passengerAuth.verifyPassengerLogin,
};
