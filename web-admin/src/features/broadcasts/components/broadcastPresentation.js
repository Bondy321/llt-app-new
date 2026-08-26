'use strict';

import { toEpochMsStrict } from '../../../utils/dateUtils';
import { getTourNotificationCategoryLabel } from '../../../utils/notificationCategories';

const MAX_BROADCAST_LENGTH = 2000;
const IDEAL_MAX_LENGTH = 240;
const EMPTY_BROADCAST_HISTORY = Object.freeze([]);
const DELIVERY_STATUS_META = {
  queued: { label: 'Queued', color: 'gray' },
  fanout_in_progress: { label: 'Fan-out in progress', color: 'blue' },
  processing: { label: 'Processing (legacy)', color: 'blue' },
  chat_queued: { label: 'Queued (legacy)', color: 'blue' },
  ticket_accepted: { label: 'Expo ticket accepted', color: 'blue' },
  ticket_rejected: { label: 'Expo ticket rejected', color: 'red' },
  receipt_pending: { label: 'Awaiting provider receipt', color: 'blue' },
  provider_accepted: { label: 'Provider accepted', color: 'green' },
  provider_rejected: { label: 'Provider rejected', color: 'red' },
  retrying: { label: 'Retry scheduled', color: 'yellow' },
  delivered: { label: 'Expo ticket accepted (legacy)', color: 'blue' },
  partial: { label: 'Partial delivery result', color: 'yellow' },
  no_recipients: { label: 'No eligible recipients', color: 'gray' },
  expired: { label: 'Expired before completion', color: 'gray' },
  failed: { label: 'Failed', color: 'red' },
};

const SKIP_REASON_LABELS = {
  no_token: 'no token',
  permission_denied: 'permission denied',
  permission_blocked: 'permission blocked',
  permission_unavailable: 'permission unavailable',
  inactive_token: 'inactive token',
  invalid_token: 'invalid token',
  opted_out: 'opted out',
  inactive_operational_session: 'inactive session',
  wrong_tour: 'wrong tour',
  duplicate_token: 'duplicate token',
  sender_excluded: 'sender excluded',
  expired_job: 'expired job',
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
    deliveryJobId: typeof payload.deliveryJobId === 'string' ? payload.deliveryJobId : null,
    skipReasons: payload.skipReasons && typeof payload.skipReasons === 'object' ? payload.skipReasons : {},
    lastErrorCode: typeof payload.deliveryErrorCode === 'string' ? payload.deliveryErrorCode : null,
  };
}

const presentSkipReasons = (skipReasons = {}) => Object.entries(skipReasons)
  .filter(([, count]) => Number(count) > 0)
  .slice(0, 4)
  .map(([reason, count]) => `${Number(count)} ${SKIP_REASON_LABELS[reason] || 'skipped'}`)
  .join(', ');

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
  presentSkipReasons,
  normalizeTourIdForPath,
};
