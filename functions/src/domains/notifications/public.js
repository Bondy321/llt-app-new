'use strict';

const { isDriverProfileAssignedToTour } = require('./notificationRecipients');
const { deleteNotificationAccountState } = require('./notificationDeviceFunctions');
const { buildNotificationJobId } = require('./notificationJobs');
const { buildMarketingAudienceUpdates } = require('./notificationMarketingAudience');
const { resolveChatJobShape } = require('./notificationProducerJobs');
const {
  NOTIFICATION_RETENTION_MS,
  nextNotificationRetentionGeneration,
  scheduleNotificationRetentionIfEligible,
} = require('./notificationRetentionIntegration');

module.exports = {
  buildNotificationJobId,
  buildMarketingAudienceUpdates,
  deleteNotificationAccountState,
  isDriverProfileAssignedToTour,
  nextNotificationRetentionGeneration,
  NOTIFICATION_RETENTION_MS,
  resolveChatJobShape,
  scheduleNotificationRetentionIfEligible,
};
