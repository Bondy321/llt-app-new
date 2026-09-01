'use strict';

// @ts-check

const { createHash } = require('node:crypto');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const {
  DEFAULT_RETENTION_BUDGETS,
  classifyNotificationRetentionEligibility,
  recoverInactiveCompactorFence,
  readNotificationRetentionRollout,
} = require('../notification-retention/public');

const compareDeleteLegacySource = async ({ db, jobId, job }) => {
  const navigation = job?.navigation || {};
  let deleted = 0;
  const paths = [];
  if (job?.sourceType === 'tour_announcement' && isValidFirebaseKey(job.tourId)
    && isValidFirebaseKey(navigation.messageId)) {
    paths.push(`broadcasts/${job.tourId}/${navigation.messageId}`);
  }
  if (job?.sourceType === 'future_tour_category_broadcast' && isValidFirebaseKey(job.categoryKey)
    && isValidFirebaseKey(navigation.broadcastId)) {
    paths.push(`category_broadcasts/${job.categoryKey}/${navigation.broadcastId}`);
  }
  for (const sourcePath of paths) {
    let matched = false;
    const result = await db.ref(sourcePath).transaction((current) => {
      const owner = current?.deliveryJobId || current?.notificationDeliveryJobId;
      if (!current || owner !== jobId
        || Number(current.createdAtMs || 0) !== Number(job.sourceOrderMs || 0)) return undefined;
      matched = true;
      return null;
    }, undefined, false);
    deleted += Number(matched && result?.committed);
  }
  return deleted;
};

const legacyJobIdentityMatches = (current, expected, jobId) => Boolean(current
  && current.jobId === jobId
  && current.status === expected.status
  && Number(current.updatedAtMs || 0) === Number(expected.updatedAtMs || 0)
  && Number(current.completedAtMs || 0) === Number(expected.completedAtMs || 0)
  && Number(current.retentionGeneration || 0) === Number(expected.retentionGeneration || 0)
  && Number(current.retentionDueAtMs || 0) === Number(expected.retentionDueAtMs || 0));

const legacyFenceId = (jobId, job, authorization) => `legacy_retention_fence_v2_${createHash('sha256')
  .update(`${jobId}:${job.status}:${Number(job.completedAtMs || 0)}:${authorization.phase}:${authorization.revision}`)
  .digest('hex').slice(0, 32)}`;

const legacyRolloutAuthorized = async ({ db, authorization }) => {
  const [rollout, rawSnapshot] = await Promise.all([
    readNotificationRetentionRollout({ db }),
    db.ref('notification_retention_rollout/v1').once('value'),
  ]);
  const rawFingerprint = createHash('sha256')
    .update(JSON.stringify(rawSnapshot.val() ?? null)).digest('hex');
  const compatibleFallback = !rollout.valid && rollout.phase === 'legacy'
    && rollout.revision === 0 && authorization.phase === 'legacy'
    && authorization.revision === 0;
  return (rollout.valid || compatibleFallback) && ['legacy', 'shadow'].includes(rollout.phase)
    && rollout.phase === authorization.phase && rollout.revision === authorization.revision
    && rawFingerprint === authorization.rawFingerprint;
};

const releaseLegacyFence = async ({ db, jobId, fenced }) => {
  await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!current || current.retentionFence?.fenceId !== fenced.retentionFence.fenceId
      || current.retentionFence?.leaseOwnerId !== fenced.retentionFence.leaseOwnerId
      || Number(current.retentionFence?.leaseRevision)
        !== Number(fenced.retentionFence.leaseRevision)) return undefined;
    return {
      ...current,
      retentionGeneration: Math.max(0, Number(fenced.retentionFence.generation) - 1),
      retentionFence: null,
    };
  }, undefined, false);
};

const renewLegacyFence = async ({
  db, jobId, fenced, nowMs, leaseMs = DEFAULT_RETENTION_BUDGETS.leaseMs,
}) => {
  let renewed = null;
  const result = await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!current || current.retentionFence?.fenceId !== fenced.retentionFence.fenceId
      || current.retentionFence?.leaseOwnerId !== fenced.retentionFence.leaseOwnerId
      || Number(current.retentionFence?.leaseRevision)
        !== Number(fenced.retentionFence.leaseRevision)
      || Number(current.retentionGeneration) !== Number(fenced.retentionGeneration)) return undefined;
    renewed = {
      ...current,
      retentionFence: {
        ...current.retentionFence,
        leaseRevision: Number(current.retentionFence.leaseRevision) + 1,
        ...(leaseMs > DEFAULT_RETENTION_BUDGETS.leaseMs
          ? { commitStatus: 'destructive' } : {}),
        leaseExpiresAtMs: Math.max(
          Number(current.retentionFence.leaseExpiresAtMs || 0),
          Math.max(nowMs, Date.now()) + leaseMs,
        ),
      },
    };
    return renewed;
  }, undefined, false);
  return result?.committed ? renewed : null;
};

const fenceLegacyJob = async ({
  db, jobId, expected, nowMs, authorization, leaseOwnerId,
}) => {
  const replacementGeneration = Number(expected?.retentionFence?.generation);
  const replacementFence = Number.isSafeInteger(replacementGeneration)
    && replacementGeneration > 0 ? {
      fenceId: legacyFenceId(jobId, expected, authorization),
      kind: 'legacy',
      status: 'active',
      completedAtMs: Number(expected.completedAtMs || 0),
      generation: replacementGeneration,
      leaseOwnerId,
      leaseRevision: Number(expected.retentionFence?.leaseRevision || 0) + 1,
      leaseExpiresAtMs: nowMs + DEFAULT_RETENTION_BUDGETS.leaseMs,
      rolloutPhase: authorization.phase,
      rolloutRevision: authorization.revision,
      ...(expected.retentionFence?.commitStatus === 'destructive'
        ? { commitStatus: 'destructive' } : {}),
    } : null;
  const recovered = await recoverInactiveCompactorFence({
    db,
    jobId,
    nowMs,
    allowDestructiveRecovery: true,
    replacementFence,
  });
  const candidate = recovered || expected;
  if (!(await legacyRolloutAuthorized({ db, authorization }))) return null;
  const requeue = (await db.ref(`notification_requeue_jobs/${jobId}`).once('value')).val();
  const activeRequeue = Boolean(requeue?.status === 'processing');
  const fenceId = legacyFenceId(jobId, candidate, authorization);
  let fenced = null;
  const result = await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!legacyJobIdentityMatches(current, candidate, jobId)) return undefined;
    if (current.retentionFence?.fenceId === fenceId
      && current.retentionFence.status === 'active') {
      if (current.retentionFence.leaseOwnerId !== leaseOwnerId
        && Number(current.retentionFence.leaseExpiresAtMs || 0) > nowMs) return undefined;
      fenced = {
        ...current,
        retentionFence: {
          ...current.retentionFence,
          leaseOwnerId,
          leaseRevision: Number(current.retentionFence.leaseRevision || 0) + 1,
          leaseExpiresAtMs: nowMs + DEFAULT_RETENTION_BUDGETS.leaseMs,
        },
      };
      return fenced;
    }
    const classification = classifyNotificationRetentionEligibility({
      job: current, nowMs, activeRequeue,
    });
    if (!classification.eligible) return undefined;
    fenced = {
      ...current,
      retentionGeneration: classification.generation,
      retentionFence: {
        fenceId,
        kind: 'legacy',
        status: 'active',
        completedAtMs: Number(current.completedAtMs || 0),
        generation: classification.generation,
        leaseOwnerId,
        leaseRevision: 1,
        leaseExpiresAtMs: nowMs + DEFAULT_RETENTION_BUDGETS.leaseMs,
        rolloutPhase: authorization.phase,
        rolloutRevision: authorization.revision,
      },
    };
    return fenced;
  }, undefined, false);
  if (!result?.committed || !fenced) return null;
  if (await legacyRolloutAuthorized({ db, authorization })) return fenced;
  await releaseLegacyFence({ db, jobId, fenced });
  return null;
};

const deleteFencedLegacyJob = async ({ db, jobId, fenced, authorization }) => {
  if (!(await legacyRolloutAuthorized({ db, authorization }))) {
    await releaseLegacyFence({ db, jobId, fenced });
    return false;
  }
  let deleted = false;
  const result = await db.ref(`notification_jobs/${jobId}`).transaction((current) => {
    if (!current || current.retentionFence?.fenceId !== fenced.retentionFence.fenceId
      || current.retentionFence.status !== 'active'
      || current.retentionFence.leaseOwnerId !== fenced.retentionFence.leaseOwnerId
      || Number(current.retentionFence.leaseRevision)
        !== Number(fenced.retentionFence.leaseRevision)
      || Number(current.retentionGeneration) !== Number(fenced.retentionGeneration)) return undefined;
    deleted = true;
    return null;
  }, undefined, false);
  return Boolean(deleted && result?.committed);
};

module.exports = {
  compareDeleteLegacySource,
  deleteFencedLegacyJob,
  fenceLegacyJob,
  legacyRolloutAuthorized,
  releaseLegacyFence,
  renewLegacyFence,
};
