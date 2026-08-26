'use strict';

// @ts-check

const CRITICAL_WARNING_STATUSES = new Set([
  'no_recipients', 'ticket_rejected', 'partial', 'submission_unknown', 'expired',
]);

/** @param {any} db @param {any} job @param {number} nowMs */
const publishCriticalFanoutWarning = async (db, job, nowMs) => {
  if (job.priorityClass !== 'critical' || !CRITICAL_WARNING_STATUSES.has(job.status)) return;
  await db.ref(`notification_delivery_warnings/${job.jobId}`).update({
    jobId: job.jobId,
    tourId: job.tourId || null,
    eventId: job.eventId || null,
    severity: 'critical',
    code: job.status.toUpperCase(),
    status: 'open',
    updatedAtMs: nowMs,
  });
};

/** @param {any} db @param {any} job @param {number} nowMs @param {Function} syncSourceStatus @param {Function} publishCriticalWarning */
const finalizeCompletedFanout = async (db, job, nowMs, syncSourceStatus, publishCriticalWarning) => {
  await syncSourceStatus(db, job, nowMs);
  await publishCriticalWarning(db, job, nowMs);
};

module.exports = { finalizeCompletedFanout, publishCriticalFanoutWarning };
