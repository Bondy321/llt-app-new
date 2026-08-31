'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { DEFAULT_LEASE_MS } = require('./notificationJobs');

const createNotificationRetrySubmission = ({
  buildExpoPushMessage,
  handleExpoRequestFailure,
  persistTicketResult,
  renewNotificationJobSubmissionFence,
  transitionDeliveryAttempt,
}) => {
  const acquireNotificationRetrySubmissionFence = async ({
    jobRef, observedJob, nowMs, ownerId = randomUUID(),
  }) => {
    let acquired = false;
    const result = await jobRef.transaction((current) => {
      if (!current || current.jobId !== observedJob?.jobId
        || current.status === 'privacy_deleted' || current.status === 'expired'
        || current.supersededByJobId || Number(current.expiresAtMs || 0) <= nowMs
        || !current.presentation?.title || !current.presentation?.body) return undefined;
      if (current.lease && Number(current.lease.expiresAtMs || 0) > nowMs
        && current.lease.ownerId !== ownerId) return undefined;
      acquired = true;
      return {
        ...current,
        lease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + DEFAULT_LEASE_MS },
      };
    });
    const job = result?.snapshot?.val?.() || null;
    return { acquired: Boolean(acquired && job?.lease?.ownerId === ownerId), job, ownerId };
  };

  const releaseNotificationRetrySubmissionFence = async ({ jobRef, ownerId }) => {
    let released = false;
    const result = await jobRef.transaction((current) => {
      if (!current || current.lease?.ownerId !== ownerId) return undefined;
      released = true;
      return { ...current, lease: null };
    });
    return Boolean(released && result?.committed);
  };

  /** Retry worker is the only owner allowed to submit a retry generation. */
  const retryNotificationDeliveryAttempt = async ({
    db = admin.database(), job, attemptId, attempt, recipient,
    nowMs = Date.now(), expo = getExpoPushClient(),
  }) => {
    const jobRef = db.ref(`notification_jobs/${job.jobId}`);
    const jobFence = await acquireNotificationRetrySubmissionFence({ jobRef, observedJob: job, nowMs });
    if (!jobFence.acquired) return { success: false, reason: 'JOB_NOT_CLAIMED' };
    const attemptRef = db.ref(`notification_delivery_attempts/${attemptId}`);
    try {
      const currentJob = jobFence.job;
      let message;
      try {
        message = buildExpoPushMessage(currentJob, recipient, nowMs);
      } catch (_error) {
        await transitionDeliveryAttempt(db, attemptId, attempt, {
          status: 'ticket_rejected', ticketStatus: 'ticket_rejected',
          retryable: false, safeErrorCode: 'PAYLOAD_TOO_LARGE',
        }, nowMs);
        return { success: false, reason: 'PAYLOAD_TOO_LARGE' };
      }
      const ownerId = randomUUID();
      let acquired = false;
      const lease = await attemptRef.transaction((current) => {
        if (!current || current.status !== 'retrying'
          || Number(current.availableAtMs || 0) > nowMs) return undefined;
        if (current.retryLease && Number(current.retryLease.expiresAtMs || 0) > nowMs) return undefined;
        acquired = true;
        return {
          ...current,
          retryLease: { ownerId, acquiredAtMs: nowMs, expiresAtMs: nowMs + 120_000 },
          updatedAtMs: nowMs,
        };
      });
      const leased = lease?.snapshot?.val?.() || attempt;
      if (!acquired || leased.retryLease?.ownerId !== ownerId) {
        return { success: false, reason: 'NOT_CLAIMED' };
      }
      const sending = await transitionDeliveryAttempt(db, attemptId, leased, {
        status: 'request_started',
        requestStartedAtMs: nowMs,
        attemptNumber: Number(leased.attemptNumber || 0) + 1,
      }, nowMs);
      if (!(await renewNotificationJobSubmissionFence({
        jobRef, leaseOwnerId: jobFence.ownerId, nowMs,
      }))) return { success: false, reason: 'JOB_LEASE_LOST' };
      let tickets;
      try {
        tickets = await expo.sendPushNotificationsAsync([message]);
      } catch (error) {
        const classified = await handleExpoRequestFailure(
          db, currentJob, { attemptRef, attemptId, attempt: sending }, nowMs, error,
        );
        return {
          success: false,
          reason: classified.outcome === 'unknown' ? 'SUBMISSION_UNKNOWN' : classified.safeErrorCode,
        };
      }
      await persistTicketResult({
        db,
        job: currentJob,
        claimed: { attemptRef, attemptId, attempt: sending },
        recipient,
        ticket: tickets[0],
        nowMs,
      });
      return { success: true };
    } finally {
      await releaseNotificationRetrySubmissionFence({ jobRef, ownerId: jobFence.ownerId });
    }
  };

  return {
    acquireNotificationRetrySubmissionFence,
    releaseNotificationRetrySubmissionFence,
    retryNotificationDeliveryAttempt,
  };
};

module.exports = { createNotificationRetrySubmission };
