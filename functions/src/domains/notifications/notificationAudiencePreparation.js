'use strict';

// @ts-check

const { evaluateAudienceCandidate } = require('./notificationAudiencePage');

const MAX_CONCURRENCY = 10;
const recordMetric = (metrics, key, amount = 1) => {
  if (metrics && typeof metrics === 'object') metrics[key] = Number(metrics[key] || 0) + amount;
};

const createNotificationAudiencePreparation = ({
  buildExpoPushMessage,
  claimDeliveryAttempt,
  mapWithConcurrency,
  transitionDeliveryAttempt,
}) => {
  /** @param {any} db @param {string} jobId @param {string} authUid @param {string} pageId */
  const claimAudienceCandidate = async (db, jobId, authUid, pageId, metrics = null) => {
    recordMetric(metrics, 'transactionAttempts');
    const claim = await db.ref(`notification_job_audience_claims/${jobId}/${authUid}`)
      .transaction((current) => current || pageId);
    return claim?.snapshot?.val?.() === pageId;
  };

  const prepareDeliveryPage = async (
    db,
    job,
    candidates,
    pageId,
    nowMs,
    metrics = null,
    shadowIndexedCandidates = [],
  ) => { // eslint-disable-line complexity -- one bounded preparation boundary owns claims and shadow comparison
    const skipReasons = {};
    const prepared = [];
    let eligibleCount = 0;
    const audienceComparison = {
      matchedEligible: 0,
      legacyEligibleMissingFromIndex: 0,
      indexedEligibleMissingFromLegacy: 0,
      indexedCandidateRejectedByAuthority: 0,
    };
    let comparisonObserved = false;
    const candidateClaims = await mapWithConcurrency(candidates, MAX_CONCURRENCY, async (candidate) => ({
      candidate,
      claimed: await claimAudienceCandidate(db, job.jobId, candidate.authUid, pageId, metrics),
    }));
    const uniqueCandidates = candidateClaims.filter((entry) => entry.claimed).map((entry) => entry.candidate);
    const evaluations = await mapWithConcurrency(uniqueCandidates, MAX_CONCURRENCY, async (candidate) => ({
      candidate,
      result: await evaluateAudienceCandidate({ db, job, candidate, nowMs, metrics }),
    }));
    const eligible = [];
    const pageTokenClaims = new Set();
    for (const { candidate, result } of evaluations) {
      if (typeof candidate.shadowIndexedDiscovered === 'boolean') {
        comparisonObserved = true;
        if (result.eligible && candidate.shadowIndexedDiscovered) audienceComparison.matchedEligible += 1;
        else if (result.eligible) audienceComparison.legacyEligibleMissingFromIndex += 1;
      }
      const reason = result.eligible ? null : (result.reason || 'invalid_token');
      if (reason) {
        skipReasons[reason] = Number(skipReasons[reason] || 0) + 1;
        continue;
      }
      if (pageTokenClaims.has(result.tokenHash)) {
        skipReasons.duplicate_token = Number(skipReasons.duplicate_token || 0) + 1;
        continue;
      }
      pageTokenClaims.add(result.tokenHash);
      eligible.push(result);
    }
    const attemptClaims = await mapWithConcurrency(eligible, MAX_CONCURRENCY, async (result) => ({
      result,
      claimed: await claimDeliveryAttempt(db, job, result, nowMs, 1, metrics),
    }));
    for (const { result, claimed } of attemptClaims) {
      if (!claimed.claimed && !claimed.represented) {
        const claimReason = claimed.reason || 'duplicate_token';
        skipReasons[claimReason] = Number(skipReasons[claimReason] || 0) + 1;
        continue;
      }
      eligibleCount += 1;
      if (!claimed.claimed) continue;
      try {
        prepared.push({ recipient: result, claimed, message: buildExpoPushMessage(job, result, nowMs) });
        recordMetric(metrics, 'providerMessagesPrepared');
      } catch (_error) {
        await transitionDeliveryAttempt(db, claimed.attemptId, claimed.attempt, {
          status: 'ticket_rejected',
          ticketStatus: 'ticket_rejected',
          retryable: false,
          submissionLease: null,
          safeErrorCode: 'PAYLOAD_TOO_LARGE',
        }, nowMs);
      }
    }
    if (shadowIndexedCandidates.length) {
      comparisonObserved = true;
      const indexedOutcomes = await mapWithConcurrency(
        shadowIndexedCandidates,
        MAX_CONCURRENCY,
        async (candidate) => ({
          candidate,
          result: await evaluateAudienceCandidate({ db, job, candidate, nowMs, metrics }),
        }),
      );
      audienceComparison.indexedCandidateRejectedByAuthority += indexedOutcomes
        .filter((outcome) => !outcome.result.eligible).length;
      const indexedEligible = indexedOutcomes.filter((outcome) => outcome.result.eligible);
      const legacyClaims = await mapWithConcurrency(indexedEligible, MAX_CONCURRENCY, async (outcome) => {
        recordMetric(metrics, 'rtdbDirectReads');
        const claim = await db.ref(`notification_job_audience_claims/${job.jobId}/${outcome.candidate.authUid}`)
          .once('value');
        return claim.exists();
      });
      audienceComparison.indexedEligibleMissingFromLegacy += legacyClaims.filter((exists) => !exists).length;
    }
    return {
      prepared,
      skipReasons,
      eligibleCount,
      audienceCount: uniqueCandidates.length,
      audienceComparison: comparisonObserved ? audienceComparison : null,
    };
  };

  return { claimAudienceCandidate, prepareDeliveryPage };
};

module.exports = { createNotificationAudiencePreparation };
