'use strict';

// @ts-check

const NOTIFICATION_TYPES = Object.freeze({
  TOUR_ANNOUNCEMENT: 'tour_announcement',
  GROUP_CHAT: 'passenger_group_chat',
  GROUP_PHOTO: 'group_photo',
  INTERNAL_DRIVER_CHAT: 'internal_driver_chat',
  ITINERARY_CHANGE: 'itinerary_change',
  DRIVER_TOUR_PACK_CHANGE: 'driver_tour_pack_change',
  SAFETY_REPORT: 'safety_report',
  CRITICAL_SAFETY: 'critical_safety',
  FUTURE_TOUR_BROADCAST: 'future_tour_category_broadcast',
  SERVER_TEST: 'server_test_notification',
});

const CHANNELS = Object.freeze({
  LEGACY: 'default',
  SAFETY: 'llt_safety_v2',
  DRIVER_OPERATIONS: 'llt_driver_operations_v2',
  TOUR_UPDATES: 'llt_tour_updates_v2',
  GROUP_CHAT: 'llt_group_chat_v2',
  GROUP_PHOTOS: 'llt_group_photos_v2',
  FUTURE_TOURS: 'llt_future_tours_v2',
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const POLICY = Object.freeze({
  [NOTIFICATION_TYPES.TOUR_ANNOUNCEMENT]: Object.freeze({
    preferencePath: ['preferences', 'ops', 'driver_updates'],
    requiresActiveSession: true,
    senderExcluded: true,
    channelId: CHANNELS.TOUR_UPDATES,
    priority: 'default',
    ttlMs: DAY_MS,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'active',
    lockScreenPreviewPolicy: 'bounded_admin_text',
    mayCoalesce: false,
    mandatoryInAppRecord: true,
    bypassesOptionalPreferences: false,
    retryClass: 'standard',
  }),
  [NOTIFICATION_TYPES.GROUP_CHAT]: Object.freeze({
    preferencePath: ['preferences', 'ops', 'group_chat'],
    requiresActiveSession: true,
    senderExcluded: true,
    channelId: CHANNELS.GROUP_CHAT,
    priority: 'default',
    ttlMs: 6 * HOUR_MS,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'active',
    lockScreenPreviewPolicy: 'bounded_chat_preview',
    mayCoalesce: false,
    mandatoryInAppRecord: false,
    bypassesOptionalPreferences: false,
    retryClass: 'chat',
  }),
  [NOTIFICATION_TYPES.GROUP_PHOTO]: Object.freeze({
    preferencePath: ['preferences', 'ops', 'group_photos'],
    requiresActiveSession: true,
    senderExcluded: true,
    channelId: CHANNELS.GROUP_PHOTOS,
    priority: 'default',
    ttlMs: 6 * HOUR_MS,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'active',
    lockScreenPreviewPolicy: 'generic_photo_copy_no_media_url',
    mayCoalesce: false,
    mandatoryInAppRecord: false,
    bypassesOptionalPreferences: false,
    retryClass: 'chat',
  }),
  [NOTIFICATION_TYPES.INTERNAL_DRIVER_CHAT]: Object.freeze({
    preferencePath: ['preferences', 'ops', 'driver_updates'],
    requiresActiveSession: true,
    senderExcluded: true,
    channelId: CHANNELS.DRIVER_OPERATIONS,
    priority: 'high',
    ttlMs: 4 * HOUR_MS,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'time-sensitive',
    lockScreenPreviewPolicy: 'bounded_driver_operations_text',
    mayCoalesce: false,
    mandatoryInAppRecord: false,
    bypassesOptionalPreferences: false,
    retryClass: 'chat',
  }),
  [NOTIFICATION_TYPES.ITINERARY_CHANGE]: Object.freeze({
    preferencePath: ['preferences', 'ops', 'itinerary_changes'],
    requiresActiveSession: true,
    senderExcluded: false,
    channelId: CHANNELS.TOUR_UPDATES,
    priority: 'default',
    ttlMs: DAY_MS,
    collapseMode: 'latest_by_tour',
    sound: 'default',
    interruptionLevel: 'active',
    lockScreenPreviewPolicy: 'bounded_itinerary_summary',
    mayCoalesce: true,
    mandatoryInAppRecord: true,
    bypassesOptionalPreferences: false,
    retryClass: 'standard',
  }),
  [NOTIFICATION_TYPES.DRIVER_TOUR_PACK_CHANGE]: Object.freeze({
    preferencePath: ['preferences', 'ops', 'driver_updates'],
    requiresActiveSession: true,
    senderExcluded: false,
    channelId: CHANNELS.DRIVER_OPERATIONS,
    priority: 'high',
    ttlMs: 12 * HOUR_MS,
    collapseMode: 'latest_by_departure',
    sound: 'default',
    interruptionLevel: 'time-sensitive',
    lockScreenPreviewPolicy: 'bounded_driver_operations_text',
    mayCoalesce: true,
    mandatoryInAppRecord: true,
    bypassesOptionalPreferences: false,
    retryClass: 'operations',
  }),
  [NOTIFICATION_TYPES.SAFETY_REPORT]: Object.freeze({
    preferencePath: null,
    requiresActiveSession: true,
    senderExcluded: true,
    channelId: CHANNELS.SAFETY,
    priority: 'high',
    ttlMs: 2 * HOUR_MS,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'time-sensitive',
    lockScreenPreviewPolicy: 'generic_safety_copy_no_incident_text',
    mayCoalesce: false,
    mandatoryInAppRecord: true,
    bypassesOptionalPreferences: true,
    retryClass: 'safety',
  }),
  [NOTIFICATION_TYPES.CRITICAL_SAFETY]: Object.freeze({
    preferencePath: null,
    requiresActiveSession: true,
    senderExcluded: true,
    channelId: CHANNELS.SAFETY,
    priority: 'high',
    ttlMs: 30 * 60 * 1000,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'time-sensitive',
    lockScreenPreviewPolicy: 'urgent_generic_safety_copy_no_incident_text',
    mayCoalesce: false,
    mandatoryInAppRecord: true,
    bypassesOptionalPreferences: true,
    retryClass: 'critical',
  }),
  [NOTIFICATION_TYPES.FUTURE_TOUR_BROADCAST]: Object.freeze({
    preferencePath: null,
    requiresActiveSession: false,
    senderExcluded: false,
    channelId: CHANNELS.FUTURE_TOURS,
    priority: 'default',
    ttlMs: 7 * DAY_MS,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'passive',
    lockScreenPreviewPolicy: 'bounded_marketing_preview',
    mayCoalesce: false,
    mandatoryInAppRecord: true,
    bypassesOptionalPreferences: false,
    retryClass: 'marketing',
  }),
  [NOTIFICATION_TYPES.SERVER_TEST]: Object.freeze({
    preferencePath: null,
    requiresActiveSession: false,
    senderExcluded: false,
    channelId: CHANNELS.DRIVER_OPERATIONS,
    priority: 'high',
    ttlMs: HOUR_MS,
    collapseMode: 'none',
    sound: 'default',
    interruptionLevel: 'active',
    lockScreenPreviewPolicy: 'fixed_diagnostic_copy',
    mayCoalesce: false,
    mandatoryInAppRecord: false,
    bypassesOptionalPreferences: true,
    retryClass: 'standard',
  }),
});

const SAFE_NOTIFICATION_STATUSES = Object.freeze([
  'queued',
  'fanout_in_progress',
  'ticket_accepted',
  'ticket_rejected',
  'receipt_pending',
  'provider_accepted',
  'provider_rejected',
  'retrying',
  'expired',
  'partial',
  'no_recipients',
]);

/** @param {string} notificationType */
const getNotificationDeliveryPolicy = (notificationType) => {
  const policy = POLICY[notificationType];
  if (!policy) throw new Error('Unsupported notification type');
  return policy;
};

/** @param {string} notificationType @param {Record<string, any>} context */
const buildDeliveryGrouping = (notificationType, context = {}) => {
  const policy = getNotificationDeliveryPolicy(notificationType);
  const tourId = typeof context.tourId === 'string' ? context.tourId : '';
  const departureKey = typeof context.departureKey === 'string' ? context.departureKey : '';
  const categoryKey = typeof context.categoryKey === 'string' ? context.categoryKey : '';
  const eventId = typeof context.eventId === 'string' ? context.eventId : '';
  return {
    collapseId: policy.collapseMode === 'latest_by_tour'
      ? `itinerary:${tourId}`
      : (policy.collapseMode === 'latest_by_departure' ? `driver-pack:${departureKey}` : null),
    androidTag: eventId
      ? `safety:${eventId}`
      : (categoryKey ? `future-tour:${categoryKey}` : (tourId ? `${notificationType}:${tourId}` : notificationType)),
    iosThreadId: categoryKey ? `future-tour:${categoryKey}` : (tourId ? `tour:${tourId}` : notificationType),
  };
};

module.exports = {
  CHANNELS,
  NOTIFICATION_TYPES,
  POLICY,
  SAFE_NOTIFICATION_STATUSES,
  buildDeliveryGrouping,
  getNotificationDeliveryPolicy,
};
