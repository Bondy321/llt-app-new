'use strict';

// @ts-check

const { admin } = require('../../bootstrap/firebaseAdmin');

/** @param {any} attempt */
// eslint-disable-next-line complexity -- each durable attempt state contributes to one bounded counter shape
const attemptCountShape = (attempt) => ({
  ticketAccepted: attempt?.ticketStatus === 'ticket_accepted' ? 1 : 0,
  ticketRejected: attempt?.ticketStatus === 'ticket_rejected' ? 1 : 0,
  receiptPending: attempt?.receiptStatus === 'receipt_pending' ? 1 : 0,
  receiptAccepted: attempt?.receiptStatus === 'provider_accepted' ? 1 : 0,
  receiptRejected: attempt?.receiptStatus === 'provider_rejected' ? 1 : 0,
  retrying: attempt?.status === 'retrying'
    || (attempt?.countsPublished === true && ['prepared', 'request_started'].includes(attempt?.status)) ? 1 : 0,
  submissionUnknown: attempt?.status === 'submission_unknown' ? 1 : 0,
});

/** @param {string} jobId @param {any} before @param {any} after */
const buildAttemptCountDeltaUpdates = (jobId, before, after) => {
  const previous = attemptCountShape(before);
  const next = attemptCountShape(after);
  const updates = {};
  Object.keys(next).forEach((key) => {
    const delta = next[key] - previous[key];
    if (delta) updates[`notification_jobs/${jobId}/counts/${key}`] = admin.database.ServerValue.increment(delta);
  });
  return updates;
};

module.exports = { attemptCountShape, buildAttemptCountDeltaUpdates };
