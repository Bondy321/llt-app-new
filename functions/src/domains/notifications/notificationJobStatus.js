'use strict';

// @ts-check

const TERMINAL_NOTIFICATION_JOB_STATUSES = new Set([
  'ticket_rejected',
  'provider_accepted',
  'provider_rejected',
  'partial',
  'submission_unknown',
  'expired',
  'no_recipients',
]);

/** @param {unknown} status */
const isTerminalNotificationJobStatus = (status) => (
  typeof status === 'string' && TERMINAL_NOTIFICATION_JOB_STATUSES.has(status)
);

module.exports = { TERMINAL_NOTIFICATION_JOB_STATUSES, isTerminalNotificationJobStatus };
