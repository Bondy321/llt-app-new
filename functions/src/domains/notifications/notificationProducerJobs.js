'use strict';

// @ts-check

const { buildPushNavigationData } = require('./pushNavigationData');
const { buildChatNotificationContent, buildSafetyNotificationContent, resolveTrimmedString } = require('./notificationPolicy');
const { NOTIFICATION_TYPES } = require('./notificationDeliveryPolicy');
const { createNotificationJobRecord } = require('./notificationJobs');
const { buildTourNotificationId } = require('./notificationState');

const resolveChatJobShape = ({ tourId, messageId, messageData, isAdmin }) => {
  const isPhoto = Number(messageData?.schemaVersion) === 2 && messageData?.type === 'image';
  return { isPhoto, notificationType: isAdmin ? NOTIFICATION_TYPES.TOUR_ANNOUNCEMENT : (isPhoto ? NOTIFICATION_TYPES.GROUP_PHOTO : NOTIFICATION_TYPES.GROUP_CHAT), sourceType: isAdmin ? 'tour_announcement' : (isPhoto ? 'group_photo_message' : 'group_chat_message'), sourceId: isAdmin && resolveTrimmedString(messageData?.broadcastId) ? `${tourId}:${messageData.broadcastId}` : `${tourId}:${messageId}${isPhoto ? `:${messageData.photoId}` : ''}`, noticeId: isAdmin ? buildTourNotificationId({ type: 'announcement', tourId, sourceId: messageData.broadcastId || messageId }) : null };
};
const buildChatNavigation = (tourId, messageId, messageData, shape, nowMs, isAdmin) => buildPushNavigationData({ tourId, screen: 'Chat', messageId, noticeId: shape.noticeId, photoId: shape.isPhoto ? messageData.photoId : null, notificationType: shape.notificationType, timestamp: Number(messageData?.timestamp) || nowMs, expiresAtMs: nowMs + (isAdmin ? 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000) });
/** @param {any} input */
const buildChatNotificationJob = ({
  tourId,
  messageId,
  messageData,
  tourName = 'Tour Chat',
  isAdmin = false,
  nowMs = Date.now(),
}) => {
  const shape = resolveChatJobShape({ tourId, messageId, messageData, isAdmin });
  const content = buildChatNotificationContent({ messageData, tourName, isAdmin });
  return createNotificationJobRecord({
    notificationType: shape.notificationType,
    sourceType: shape.sourceType,
    sourceId: shape.sourceId,
    audienceType: 'tour',
    tourId,
    senderAuthUid: resolveTrimmedString(messageData?.senderUid),
    senderPrincipalId: resolveTrimmedString(messageData?.senderStableId || messageData?.senderId),
    presentation: content,
    navigation: buildChatNavigation(tourId, messageId, messageData, shape, nowMs, isAdmin),
    nowMs,
  });
};

/** @param {any} input */
const buildInternalChatNotificationJob = ({ tourId, messageId, messageData, tourName = 'Tour Chat', nowMs = Date.now() }) => {
  const content = buildChatNotificationContent({ messageData, tourName });
  return createNotificationJobRecord({
    notificationType: NOTIFICATION_TYPES.INTERNAL_DRIVER_CHAT,
    sourceType: 'internal_driver_chat_message',
    sourceId: `${tourId}:${messageId}`,
    audienceType: 'assigned_drivers',
    tourId,
    senderAuthUid: resolveTrimmedString(messageData?.senderUid),
    senderPrincipalId: resolveTrimmedString(messageData?.senderStableId || messageData?.senderId),
    presentation: { title: `Driver team · ${tourName}`, body: content.body },
    navigation: buildPushNavigationData({
      tourId,
      screen: 'Chat',
      messageId,
      notificationType: NOTIFICATION_TYPES.INTERNAL_DRIVER_CHAT,
      internalDriverChat: true,
      timestamp: Number(messageData?.timestamp) || nowMs,
      expiresAtMs: nowMs + (4 * 60 * 60 * 1000),
    }),
    nowMs,
  });
};

/** @param {any} input */
const buildItineraryNotificationJob = ({ tourId, sourceId, change, noticeId, nowMs = Date.now() }) => createNotificationJobRecord({
  notificationType: NOTIFICATION_TYPES.ITINERARY_CHANGE,
  sourceType: 'itinerary_semantic_change',
  sourceId: `${tourId}:${sourceId}`,
  audienceType: 'tour',
  tourId,
  coalescingKey: `itinerary:${tourId}`,
  presentation: { title: change.title, body: change.body },
  navigation: buildPushNavigationData({
    tourId,
    screen: 'Itinerary',
    noticeId,
    notificationType: NOTIFICATION_TYPES.ITINERARY_CHANGE,
    timestamp: nowMs,
    expiresAtMs: nowMs + (24 * 60 * 60 * 1000),
  }),
  nowMs,
});

/** @param {any} input */
const buildDriverTourPackNotificationJob = ({ departureKey, pack, change, noticeId, allowedDriverIds = null, nowMs = Date.now() }) => createNotificationJobRecord({
  notificationType: NOTIFICATION_TYPES.DRIVER_TOUR_PACK_CHANGE,
  sourceType: 'driver_tour_pack_revision',
  sourceId: `${departureKey}:${pack.revision}`,
  audienceType: 'assigned_drivers',
  tourId: pack.tourId,
  departureKey,
  allowedDriverIds,
  coalescingKey: `driver-tour-pack:${departureKey}`,
  presentation: {
    title: 'Operational information changed',
    body: change.critical
      ? 'A critical operational update requires your acknowledgement in the Driver Command Centre.'
      : 'Open the Driver Command Centre to review the updated sections.',
  },
  navigation: buildPushNavigationData({
    screen: 'DriverTourPack',
    tourId: pack.tourId,
    noticeId,
    notificationType: NOTIFICATION_TYPES.DRIVER_TOUR_PACK_CHANGE,
    departureKey,
    revision: pack.revision,
    changedSections: change.changedSections,
    critical: change.critical,
    requiresAcknowledgement: change.requiresAcknowledgement,
    timestamp: nowMs,
    expiresAtMs: nowMs + (12 * 60 * 60 * 1000),
  }),
  nowMs,
});

/** @param {any} input */
const buildSafetyNotificationJob = ({ tourId, eventId, alert, tourName, nowMs = Date.now() }) => {
  const critical = alert?.isSOS === true || alert?.severity === 'critical';
  const notificationType = critical ? NOTIFICATION_TYPES.CRITICAL_SAFETY : NOTIFICATION_TYPES.SAFETY_REPORT;
  const content = buildSafetyNotificationContent({ alert, tourName });
  return createNotificationJobRecord({
    notificationType,
    sourceType: critical ? 'critical_safety_event' : 'safety_event',
    sourceId: `${tourId}:${eventId}`,
    audienceType: 'safety',
    tourId,
    eventId,
    senderAuthUid: resolveTrimmedString(alert?.reporterAuthUid || alert?.userId),
    senderPrincipalId: resolveTrimmedString(alert?.principalId),
    presentation: { title: content.title, body: content.body },
    navigation: buildPushNavigationData({
      screen: 'SafetyAlertDetail',
      tourId,
      eventId,
      notificationType,
      timestamp: Number(alert?.receivedAtMs || alert?.timestampMs) || nowMs,
      expiresAtMs: nowMs + (critical ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000),
    }),
    nowMs,
  });
};

/** @param {any} input */
const buildMarketingNotificationJob = ({ categoryKey, broadcastId, categoryLabel, broadcast, nowMs = Date.now() }) => {
  const expiresAtMs = Number.isSafeInteger(broadcast?.expiresAtMs)
    ? broadcast.expiresAtMs
    : nowMs + (7 * 24 * 60 * 60 * 1000);
  return createNotificationJobRecord({
    notificationType: NOTIFICATION_TYPES.FUTURE_TOUR_BROADCAST,
    sourceType: 'future_tour_category_broadcast',
    sourceId: `${categoryKey}:${broadcastId}`,
    audienceType: 'marketing',
    categoryKey,
    presentation: {
      title: `New ${categoryLabel} tour alert`,
      body: resolveTrimmedString(broadcast.message),
    },
    navigation: buildPushNavigationData({
      screen: 'MarketingNotificationDetail',
      notificationType: NOTIFICATION_TYPES.FUTURE_TOUR_BROADCAST,
      categoryKey,
      broadcastId,
      timestamp: broadcast.createdAtMs,
      expiresAtMs,
    }),
    nowMs,
    expiresAtMs,
  });
};

module.exports = {
  buildChatNotificationJob,
  buildDriverTourPackNotificationJob,
  buildInternalChatNotificationJob,
  buildItineraryNotificationJob,
  buildMarketingNotificationJob,
  buildSafetyNotificationJob,
};
