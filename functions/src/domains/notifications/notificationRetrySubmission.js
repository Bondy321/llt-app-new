'use strict';

// @ts-check

const { transactExistingRecord } = require('../../infrastructure/database/existingRecordTransaction');

const { reserveProviderBudget } = require('./notificationProviderBudget');
const { randomUUID } = require('node:crypto');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { DEFAULT_LEASE_MS } = require('./notificationJobs');
const { isNotificationLifecycleRetentionFenced } = require('./notificationRetentionIntegration');

const acquireNotificationAttemptRetryLease = async ({ attemptRef, attempt, nowMs }) => {
  const ownerId = randomUUID();
  let acquired = false;
  const lease = await transactExistingRecord(attemptRef, (current) => {
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
  return { attempt: leased, acquired: Boolean(lease?.applied && acquired && leased.retryLease?.ownerId === ownerId) };
};

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
    const result = await transactExistingRecord(jobRef, (current) => {
      if (!current || current.jobId !== observedJob?.jobId
        || isNotificationLifecycleRetentionFenced(current, nowMs)
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
    return { acquired: Boolean(result?.applied && acquired && job?.lease?.ownerId === ownerId), job, ownerId };
  };

  const releaseNotificationRetrySubmissionFence = async ({ jobRef, ownerId }) => {
    let released = false;
    const result = await transactExistingRecord(jobRef, (current) => {
      if (!current || current.lease?.ownerId !== ownerId) return undefined;
      released = true;
      return { ...current, lease: null };
    });
    return Boolean(released && result?.applied);
  };

  /** Retry worker is the only owner allowed to submit a retry generation. */
  const retryNotificationDeliveryAttempt = async ({
    db = admin.database(), job, attemptId, attempt, recipient,
    nowMs = Date.now(), expo = getExpoPushClient(), providerClock = Date.now,
  }) => {
    const jobRef = db.ref(`notification_jobs_v2/${job.jobId}`);
    const jobFence = await acquireNotificationRetrySubmissionFence({ jobRef, observedJob: job, nowMs });
    if (!jobFence.acquired) return { success: false, reason: 'JOB_NOT_CLAIMED' };
    const attemptRef = db.ref(`notification_delivery_attempts_v2/${attemptId}`);
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
      const claim = await acquireNotificationAttemptRetryLease({ attemptRef, attempt, nowMs });
      if (!claim.acquired) return { success: false, reason: 'NOT_CLAIMED' };
      const leased = claim.attempt;
      const sending = await transitionDeliveryAttempt(db, attemptId, leased, {
        status: 'request_started',
        requestStartedAtMs: nowMs,
        attemptNumber: Number(leased.attemptNumber || 0) + 1,
      }, nowMs);
      if (!(await renewNotificationJobSubmissionFence({
        jobRef, leaseOwnerId: jobFence.ownerId, nowMs,
      }))) return { success: false, reason: 'JOB_LEASE_LOST' };
      const budget = await reserveProviderBudget({ db, count: 1, marketing: job.audienceType === 'marketing', nowMs: providerClock() });
      if (!budget.granted || providerClock() >= budget.expiresAtMs) {
        await transitionDeliveryAttempt(db, attemptId, sending, { status: 'retrying', retryable: true, retryLease: null, requestStartedAtMs: null,
          attemptNumber: Number(leased.attemptNumber || 0), availableAtMs: budget.retryAtMs,
          safeErrorCode: 'PROJECT_PROVIDER_BUDGET' }, nowMs);
        return { success: false, reason: 'PROJECT_PROVIDER_BUDGET' };
      }
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
