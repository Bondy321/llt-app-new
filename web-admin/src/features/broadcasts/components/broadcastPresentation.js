'use strict';

import { toEpochMsStrict } from '../../../utils/dateUtils';
import { getTourNotificationCategoryLabel } from '../../../utils/notificationCategories';

const MAX_BROADCAST_LENGTH = 2000;
const IDEAL_MAX_LENGTH = 240;
const EMPTY_BROADCAST_HISTORY = Object.freeze([]);
const DELIVERY_STATUS_META = {
  queued: { label: 'Queued', color: 'gray' },
  processing: { label: 'Processing', color: 'blue' },
  chat_queued: { label: 'Preparing push', color: 'blue' },
  delivered: { label: 'Push accepted', color: 'green' },
  partial: { label: 'Partially accepted', color: 'yellow' },
  no_recipients: { label: 'No eligible recipients', color: 'gray' },
  failed: { label: 'Failed', color: 'red' },
};

const messageTemplates = [
  { value: 'arriving', label: 'Bus Arriving', message: 'The bus is arriving in 5 minutes. Please make your way to the pickup point.' },
  { value: 'delayed', label: 'Delay Notice', message: 'We apologize for the delay. The bus will arrive in approximately 15 minutes.' },
  { value: 'departed', label: 'Departed', message: 'The tour has now departed. Thank you for joining us today!' },
  { value: 'weather', label: 'Weather Update', message: 'Due to weather conditions, please dress appropriately for outdoor activities.' },
  { value: 'reminder', label: 'General Reminder', message: 'This is a reminder for all passengers on this tour.' },
  { value: 'custom', label: 'Custom Message', message: '' },
];

const normalizeTourIdForPath = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const isValidFirebaseKeySegment = (value) => {
  return typeof value === 'string' && value.length > 0 && !/[./$#[\]]/.test(value);
};

function normalizeBroadcastTimestamp(timestamp) {
  return toEpochMsStrict(timestamp);
}

function normalizeBroadcastMessage(targetId, broadcastId, payload = {}, targetType = 'tour') {
  const message = typeof payload.message === 'string' ? payload.message : '';
  const normalizedTimestamp = normalizeBroadcastTimestamp(payload.createdAtMs);
  const categoryKey = payload.categoryKey || targetId;
  const targetLabel = targetType === 'category'
    ? payload.categoryLabel || getTourNotificationCategoryLabel(categoryKey)
    : targetId;

  return {
    id: broadcastId,
    tourId: targetType === 'tour' ? targetId : null,
    categoryKey: targetType === 'category' ? categoryKey : null,
    categoryLabel: targetType === 'category' ? targetLabel : null,
    targetType,
    targetLabel,
    message,
    timestamp: normalizedTimestamp ?? payload.createdAtMs ?? null,
    timestampMs: normalizedTimestamp,
    createdByUid: payload.createdByUid || null,
    source: payload.source || null,
    deliveryStatus: payload.deliveryStatus || 'queued',
    recipientCount: Number.isFinite(Number(payload.recipientCount)) ? Number(payload.recipientCount) : null,
    successCount: Number.isFinite(Number(payload.successCount)) ? Number(payload.successCount) : null,
    errorCount: Number.isFinite(Number(payload.errorCount)) ? Number(payload.errorCount) : null,
  };
}

const getMessageTone = (message) => {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      label: 'Start drafting your announcement',
      color: 'gray',
      icon: 'info',
      helper: 'Templates are a good baseline for consistent communication.',
    };
  }

  if (trimmed.length < 24) {
    return {
      label: 'Too short for a clear update',
      color: 'yellow',
      icon: 'alert',
      helper: 'Add context such as place/time so passengers know what to do.',
    };
  }

  if (trimmed.length > IDEAL_MAX_LENGTH) {
    return {
      label: 'Long message: consider tightening',
      color: 'orange',
      icon: 'alert',
      helper: 'Push notifications perform best when concise and action-oriented.',
    };
  }

  return {
    label: 'Great length for push notifications',
    color: 'green',
    icon: 'check',
    helper: 'Clear and concise. Ready for passenger delivery.',
  };
};


export {
  DELIVERY_STATUS_META,
  EMPTY_BROADCAST_HISTORY,
  IDEAL_MAX_LENGTH,
  MAX_BROADCAST_LENGTH,
  getMessageTone,
  isValidFirebaseKeySegment,
  messageTemplates,
  normalizeBroadcastMessage,
  normalizeBroadcastTimestamp,
  normalizeTourIdForPath,
};
