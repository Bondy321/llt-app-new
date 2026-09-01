'use strict';

// @ts-check

const { randomUUID } = require('node:crypto');
const {
  NOTIFICATION_RETENTION_PATHS,
  ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES,
  TERMINAL_NOTIFICATION_ATTEMPT_STATUSES,
} = require('./constants');
const { rolloutAuthorizesCompactor } = require('./retentionContext');
const { ensureNotificationRetentionScheduled } = require('./state');
const {
  cleanupExpiredNotificationRequeueState,
} = require('./requeueRecovery');
const {
  maxMetric,
  orderedEntries,
  QUEUE_ROOTS,
  safeInteger,
} = require('./retentionEngineRuntime');
const { sweepDueRequeueRecovery } = require('./retentionRequeueSweep');

const exactExpiryPage = async ({
  db, root, orderField, nowMs, limit, metrics, metricName, canContinue,
  preserveExpired, cleanupExpired,
}) => {
  const snapshot = await db.ref(root).orderByChild(orderField).startAt(1).endAt(nowMs)
    .limitToFirst(limit + 1).once('value');
  metrics.queries += 1;
  const entries = orderedEntries(snapshot, ([leftKey, left], [rightKey, right]) => (
    Number(left?.[orderField] || 0) - Number(right?.[orderField] || 0)
      || leftKey.localeCompare(rightKey)
  ));
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  let deleted = 0;
  let preserved = 0;
  let stopped = false;
  for (const [key, expected] of entries.slice(0, limit)) {
    if (canContinue && !(await canContinue())) {
      stopped = true;
      break;
    }
    if (cleanupExpired) {
      const cleaned = await cleanupExpired({ db, key, expected, nowMs });
      deleted += Number(cleaned.deleted);
      preserved += Number(cleaned.preserved);
      metrics.transactions += 1;
      continue;
    }
    let matched = false;
    let preservedCurrent = false;
    const result = await db.ref(`${root}/${key}`).transaction((current) => {
      if (!current || Number(current[orderField] || 0) !== Number(expected[orderField] || 0)
        || Number(current[orderField] || 0) > nowMs) return undefined;
      if (preserveExpired?.(current)) {
        preservedCurrent = true;
        return { ...current, [orderField]: null, updatedAtMs: nowMs };
      }
      matched = true;
      return null;
    }, undefined, false);
    metrics.transactions += 1;
    deleted += Number(matched && result?.committed);
    preserved += Number(preservedCurrent && result?.committed);
  }
  metrics[metricName] += deleted;
  metrics.updatePaths += deleted;
  maxMetric(metrics, 'maxUpdatePaths', Number(deleted > 0));
  return { hasMore: stopped || entries.length > limit, deleted, preserved, stopped };
};

const runExactExpirySweep = async (options) => {
  let hasMore = false;
  for (let page = 0; page < options.maxPages; page += 1) {
    if (options.startPage && !(await options.startPage())) return true;
    const result = await exactExpiryPage(options);
    hasMore = result.hasMore;
    if (result.stopped || !result.hasMore || result.deleted + result.preserved === 0) break;
  }
  return hasMore;
};

const readTerminalRepairCursor = (value) => {
  const cursor = value?.cursor;
  if (!cursor || !Number.isSafeInteger(cursor.completedAtMs)
    || typeof cursor.key !== 'string' || !cursor.key) return null;
  return { completedAtMs: cursor.completedAtMs, key: cursor.key };
};

const loadTerminalRepairPage = async ({ db, nowMs, limit, cursor, metrics }) => {
  let query = db.ref('notification_jobs').orderByChild('completedAtMs');
  const supportsStartAfter = cursor && typeof query.startAfter === 'function';
  if (supportsStartAfter) query = query.startAfter(cursor.completedAtMs, cursor.key);
  else if (cursor && typeof query.startAt === 'function') {
    query = query.startAt(cursor.completedAtMs, cursor.key);
  } else query = query.startAt(1);
  const snapshot = await query.endAt(nowMs).limitToFirst(limit + 1).once('value');
  metrics.queries += 1;
  let entries = orderedEntries(snapshot, ([leftKey, left], [rightKey, right]) => (
    Number(left?.completedAtMs || 0) - Number(right?.completedAtMs || 0)
      || leftKey.localeCompare(rightKey)
  ));
  if (cursor && !supportsStartAfter) {
    entries = entries.filter(([key, job]) => Number(job?.completedAtMs || 0) > cursor.completedAtMs
      || (Number(job?.completedAtMs || 0) === cursor.completedAtMs && key > cursor.key));
  }
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  return { selected: entries.slice(0, limit), hasMore: entries.length > limit };
};

const sweepTerminalSchedulingRepair = async ({
  db, nowMs, budgets, metrics, startPage, canContinue,
}) => {
  const repairRef = db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/terminal_jobs`);
  const repair = (await repairRef.once('value')).val();
  metrics.queries += 1;
  let cursor = readTerminalRepairCursor(repair);
  let hasMore = false;
  for (let pageNumber = 0; pageNumber < budgets.maxAuxiliaryPages; pageNumber += 1) {
    if (!(await startPage()) || !(await canContinue())) return { hasMore: true, stopped: true };
    const page = await loadTerminalRepairPage({
      db, nowMs, limit: budgets.auxiliaryPageSize, cursor, metrics,
    });
    const processed = [];
    let pageScheduled = 0;
    let pageFailures = 0;
    for (const [jobId, job] of page.selected) {
      if (!(await canContinue())) return { hasMore: true, stopped: true };
      processed.push([jobId, job]);
      metrics.terminalRepairsScanned += 1;
      if (!job || (!ORDINARY_TERMINAL_NOTIFICATION_JOB_STATUSES.has(job.status)
        && job.status !== 'privacy_deleted')) continue;
      const scheduled = await ensureNotificationRetentionScheduled({ db, jobId, job, nowMs });
      if (['scheduled', 'already_scheduled', 'queue_repaired'].includes(scheduled.reason)) {
        metrics.terminalRepairsScheduled += 1;
        pageScheduled += 1;
      } else if (['already_fenced', 'active_delivery_lease', 'retention_hold',
        'requires_attention', 'already_completed'].includes(scheduled.reason)) {
        continue;
      } else {
        metrics.terminalRepairFailures += 1;
        pageFailures += 1;
      }
    }
    hasMore = page.hasMore;
    const last = processed.at(-1);
    cursor = page.hasMore && last ? {
      completedAtMs: Number(last[1]?.completedAtMs || 0), key: last[0],
    } : null;
    await repairRef.transaction((current) => ({
      schemaVersion: 1,
      cursor,
      pagesScanned: safeInteger(current?.pagesScanned) + 1,
      recordsScanned: safeInteger(current?.recordsScanned) + processed.length,
      scheduled: safeInteger(current?.scheduled) + pageScheduled,
      failures: safeInteger(current?.failures) + pageFailures,
      updatedAtMs: nowMs,
    }), undefined, false);
    metrics.transactions += 1;
    if (!page.hasMore || !processed.length) break;
  }
  return { hasMore, stopped: false };
};

const readOrphanCursor = (value) => {
  const cursor = value?.cursor;
  if (!cursor || !Number.isSafeInteger(cursor.retentionDueAtMs)
    || typeof cursor.key !== 'string' || !cursor.key) return null;
  return { retentionDueAtMs: cursor.retentionDueAtMs, key: cursor.key };
};

const loadOrphanAttemptPage = async ({ db, nowMs, limit, cursor, metrics }) => {
  let query = db.ref('notification_delivery_attempts').orderByChild('retentionDueAtMs');
  const supportsStartAfter = cursor && typeof query.startAfter === 'function';
  if (supportsStartAfter) {
    query = query.startAfter(cursor.retentionDueAtMs, cursor.key);
  } else if (cursor && typeof query.startAt === 'function') {
    query = query.startAt(cursor.retentionDueAtMs, cursor.key);
  } else {
    query = query.startAt(1);
  }
  const snapshot = await query.endAt(nowMs).limitToFirst(limit + 1).once('value');
  metrics.queries += 1;
  let entries = orderedEntries(snapshot, ([leftKey, left], [rightKey, right]) => (
    Number(left?.retentionDueAtMs || 0) - Number(right?.retentionDueAtMs || 0)
      || leftKey.localeCompare(rightKey)
  ));
  if (cursor && !supportsStartAfter) {
    entries = entries.filter(([key, attempt]) => Number(attempt?.retentionDueAtMs || 0) > cursor.retentionDueAtMs
      || (Number(attempt?.retentionDueAtMs || 0) === cursor.retentionDueAtMs && key > cursor.key));
  }
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  return { selected: entries.slice(0, limit), hasMore: entries.length > limit };
};

const exactAttemptMatches = (current, expected) => Boolean(current
  && current.jobId === expected.jobId
  && current.status === expected.status
  && Number(current.retentionDueAtMs || 0) === Number(expected.retentionDueAtMs || 0));

const withoutOrphanClaim = (attempt) => {
  const { retentionOrphanClaim: _claim, ...rest } = attempt;
  return rest;
};

const claimOrphanAttempt = async ({ db, attemptId, expected, claimId, nowMs, leaseMs, metrics }) => {
  let claimed = null;
  const result = await db.ref(`notification_delivery_attempts/${attemptId}`).transaction((current) => {
    if (!exactAttemptMatches(current, expected)) return undefined;
    if (current.retentionOrphanClaim
      && current.retentionOrphanClaim.claimId !== claimId
      && Number(current.retentionOrphanClaim.expiresAtMs || 0) > nowMs) return undefined;
    claimed = {
      ...current,
      retentionOrphanClaim: { claimId, expiresAtMs: nowMs + leaseMs },
    };
    return claimed;
  }, undefined, false);
  metrics.transactions += 1;
  return result?.committed ? claimed : null;
};

const releaseOrphanAttempt = async ({ db, attemptId, claimId, metrics }) => {
  await db.ref(`notification_delivery_attempts/${attemptId}`).transaction((current) => (
    current?.retentionOrphanClaim?.claimId === claimId ? withoutOrphanClaim(current) : undefined
  ), undefined, false);
  metrics.transactions += 1;
};

const restoreOrphanAttempt = async ({ db, attemptId, expected, claimId, metrics }) => {
  const clean = withoutOrphanClaim(expected);
  await db.ref(`notification_delivery_attempts/${attemptId}`).transaction((current) => {
    if (!current) return clean;
    if (current.retentionOrphanClaim?.claimId === claimId) return withoutOrphanClaim(current);
    return current;
  }, undefined, false);
  metrics.transactions += 1;
};

const compareDeleteAttemptQueuePointer = async ({ db, attemptId, attempt, metrics }) => {
  const root = QUEUE_ROOTS[attempt.queueKind];
  if (!root || typeof attempt.queueKey !== 'string' || !attempt.queueKey) return false;
  let deleted = false;
  const result = await db.ref(`${root}/${attempt.queueKey}`).transaction((current) => {
    if (!current || current.targetId !== attemptId
      || Number(current.version) !== Number(attempt.queueVersion)) return undefined;
    deleted = true;
    return null;
  }, undefined, false);
  metrics.transactions += 1;
  if (deleted && result?.committed) {
    metrics.updatePaths += 1;
    metrics[attempt.queueKind === 'retry' ? 'retryPointersDeleted' : 'receiptPointersDeleted'] += 1;
  }
  return Boolean(deleted && result?.committed);
};

const deleteClaimedOrphanAttempt = async ({
  db, attemptId, expected, claimId, nowMs, metrics,
}) => {
  const parentBefore = (await db.ref(`notification_jobs/${expected.jobId}`).once('value')).val();
  metrics.queries += 1;
  if (parentBefore) {
    await releaseOrphanAttempt({ db, attemptId, claimId, metrics });
    return false;
  }
  let deleted = false;
  const result = await db.ref(`notification_delivery_attempts/${attemptId}`).transaction((current) => {
    if (!exactAttemptMatches(current, expected)
      || current.retentionOrphanClaim?.claimId !== claimId
      || Number(current.retentionDueAtMs || 0) > nowMs) return undefined;
    deleted = true;
    return null;
  }, undefined, false);
  metrics.transactions += 1;
  if (!deleted || !result?.committed) return false;
  const parentAfter = (await db.ref(`notification_jobs/${expected.jobId}`).once('value')).val();
  metrics.queries += 1;
  if (parentAfter) {
    await restoreOrphanAttempt({ db, attemptId, expected, claimId, metrics });
    return false;
  }
  await compareDeleteAttemptQueuePointer({ db, attemptId, attempt: expected, metrics });
  return true;
};

const processOrphanAttempt = async ({ db, attemptId, expected, nowMs, budgets, metrics }) => {
  metrics.orphanAttemptsScanned += 1;
  if (!expected?.jobId || !TERMINAL_NOTIFICATION_ATTEMPT_STATUSES.has(expected.status)
    || !Number.isSafeInteger(expected.retentionDueAtMs)) {
    metrics.orphanAttemptsMalformed += 1;
    return false;
  }
  const parent = (await db.ref(`notification_jobs/${expected.jobId}`).once('value')).val();
  metrics.queries += 1;
  if (parent) return false;
  const claimId = `orphan_claim_${randomUUID().replace(/-/gu, '')}`;
  const claimed = await claimOrphanAttempt({
    db, attemptId, expected, claimId, nowMs, leaseMs: budgets.leaseMs, metrics,
  });
  if (!claimed) return false;
  const deleted = await deleteClaimedOrphanAttempt({
    db, attemptId, expected: claimed, claimId, nowMs, metrics,
  });
  if (deleted) {
    metrics.orphanAttemptsDeleted += 1;
    metrics.updatePaths += 1;
    maxMetric(metrics, 'maxUpdatePaths', 1);
  }
  return deleted;
};

const persistOrphanCursor = async ({ db, cursor, page, metrics, nowMs }) => {
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/orphan_attempts`).transaction((current) => ({
    schemaVersion: 1,
    cursor,
    pagesScanned: safeInteger(current?.pagesScanned) + 1,
    recordsScanned: safeInteger(current?.recordsScanned) + page.selected.length,
    malformed: safeInteger(current?.malformed) + page.malformed,
    deleted: safeInteger(current?.deleted) + page.deleted,
    updatedAtMs: nowMs,
  }), undefined, false);
  metrics.transactions += 1;
};

const sweepOrphanAttempts = async ({ db, nowMs, budgets, metrics, canContinue }) => {
  const repair = (await db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/orphan_attempts`).once('value')).val();
  metrics.queries += 1;
  const cursor = readOrphanCursor(repair);
  const page = await loadOrphanAttemptPage({
    db, nowMs, limit: budgets.orphanPageSize, cursor, metrics,
  });
  const malformedBefore = metrics.orphanAttemptsMalformed;
  const deletedBefore = metrics.orphanAttemptsDeleted;
  const processed = [];
  let stopped = false;
  for (const [attemptId, expected] of page.selected) {
    if (canContinue && !(await canContinue())) {
      stopped = true;
      break;
    }
    await processOrphanAttempt({ db, attemptId, expected, nowMs, budgets, metrics });
    processed.push([attemptId, expected]);
  }
  const last = processed.at(-1);
  const pageHasMore = stopped || processed.length < page.selected.length || page.hasMore;
  const nextCursor = pageHasMore && last ? {
    retentionDueAtMs: Number(last[1]?.retentionDueAtMs || 0),
    key: last[0],
  } : (pageHasMore ? cursor : null);
  await persistOrphanCursor({
    db,
    cursor: nextCursor,
    page: {
      selected: processed,
      malformed: metrics.orphanAttemptsMalformed - malformedBefore,
      deleted: metrics.orphanAttemptsDeleted - deletedBefore,
    },
    metrics,
    nowMs,
  });
  return { hasMore: pageHasMore, stopped };
};

const deleteOrphanMarketingDetail = async ({ db, detailId, expected, nowMs, metrics }) => {
  const jobId = expected?.deliveryJobId || expected?.notificationDeliveryJobId;
  if (typeof jobId !== 'string' || !jobId) return false;
  const parent = (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  metrics.queries += 1;
  if (parent) return false;
  let deleted = false;
  const result = await db.ref(`marketing_notification_details/${detailId}`).transaction((current) => {
    const currentOwner = current?.deliveryJobId || current?.notificationDeliveryJobId;
    if (!current || currentOwner !== jobId
      || Number(current.retentionDueAtMs || 0) !== Number(expected.retentionDueAtMs || 0)
      || Number(current.retentionDueAtMs || 0) > nowMs) return undefined;
    deleted = true;
    return null;
  }, undefined, false);
  metrics.transactions += 1;
  if (!deleted || !result?.committed) return false;
  const parentAfter = (await db.ref(`notification_jobs/${jobId}`).once('value')).val();
  metrics.queries += 1;
  if (parentAfter) {
    await db.ref(`marketing_notification_details/${detailId}`).transaction((current) => current || expected);
    metrics.transactions += 1;
    return false;
  }
  metrics.marketingDetailsDeleted += 1;
  metrics.updatePaths += 1;
  maxMetric(metrics, 'maxUpdatePaths', 1);
  return true;
};

const validMarketingCursor = (value, expectedRolloutRevision, expectedEvidenceDigest) => (
  value?.schemaVersion === 1
  && Number(value.rolloutRevision) === Number(expectedRolloutRevision)
  && value.evidenceDigest === expectedEvidenceDigest
  && Number.isSafeInteger(value.retentionDueAtMs)
  && typeof value.detailId === 'string' && value.detailId.length > 0
);

const compareMarketingCursor = (left, right) => (
  Number(left?.retentionDueAtMs || 0) - Number(right?.retentionDueAtMs || 0)
  || String(left?.detailId || '').localeCompare(String(right?.detailId || ''))
);

const persistMarketingCursor = async ({
  db, metrics, startCursor, lastCursor, hasMore,
  expectedRolloutRevision, expectedEvidenceDigest, nowMs,
}) => {
  await db.ref(`${NOTIFICATION_RETENTION_PATHS.repair}/orphan_marketing_details_cursor`)
    .transaction((current) => {
      const currentCompatible = validMarketingCursor(
        current, expectedRolloutRevision, expectedEvidenceDigest,
      );
      if (!hasMore) {
        const currentMatchesStart = (!currentCompatible && !startCursor)
          || (currentCompatible && startCursor
            && compareMarketingCursor(current, startCursor) === 0);
        return currentMatchesStart ? null : undefined;
      }
      if (!lastCursor || (currentCompatible
        && compareMarketingCursor(current, lastCursor) >= 0)) return undefined;
      return {
        schemaVersion: 1,
        rolloutRevision: expectedRolloutRevision,
        evidenceDigest: expectedEvidenceDigest,
        ...lastCursor,
        updatedAtMs: nowMs,
      };
    }, undefined, false);
  metrics.transactions += 1;
};

const sweepOrphanMarketingDetails = async ({
  db, nowMs, budgets, metrics, canContinue, startPage,
  expectedRolloutRevision, expectedEvidenceDigest,
}) => {
  if (startPage && !(await startPage())) return { hasMore: true, stopped: true };
  const cursorRecord = (await db.ref(
    `${NOTIFICATION_RETENTION_PATHS.repair}/orphan_marketing_details_cursor`,
  ).once('value')).val();
  metrics.queries += 1;
  const startCursor = validMarketingCursor(
    cursorRecord, expectedRolloutRevision, expectedEvidenceDigest,
  ) ? {
      retentionDueAtMs: cursorRecord.retentionDueAtMs,
      detailId: cursorRecord.detailId,
    } : null;
  let query = db.ref('marketing_notification_details').orderByChild('retentionDueAtMs');
  query = startCursor
    ? query.startAfter(startCursor.retentionDueAtMs, startCursor.detailId)
    : query.startAt(1);
  const snapshot = await query.endAt(nowMs).limitToFirst(budgets.auxiliaryPageSize + 1)
    .once('value');
  metrics.queries += 1;
  const entries = orderedEntries(snapshot, ([leftKey, left], [rightKey, right]) => (
    Number(left?.retentionDueAtMs || 0) - Number(right?.retentionDueAtMs || 0)
      || leftKey.localeCompare(rightKey)
  ));
  maxMetric(metrics, 'maxRecordsInMemory', entries.length);
  let stopped = false;
  const selected = entries.slice(0, budgets.auxiliaryPageSize);
  const processed = [];
  for (const [detailId, detail] of selected) {
    if (canContinue && !(await canContinue())) {
      stopped = true;
      break;
    }
    await deleteOrphanMarketingDetail({ db, detailId, expected: detail, nowMs, metrics });
    processed.push([detailId, detail]);
  }
  const hasMore = stopped || processed.length < selected.length
    || entries.length > budgets.auxiliaryPageSize;
  if (stopped || !startPage || await startPage()) {
    const last = processed.at(-1);
    await persistMarketingCursor({
      db,
      metrics,
      startCursor,
      lastCursor: last ? { retentionDueAtMs: Number(last[1]?.retentionDueAtMs), detailId: last[0] } : null,
      hasMore,
      expectedRolloutRevision,
      expectedEvidenceDigest,
      nowMs,
    });
  } else stopped = true;
  return { hasMore: hasMore || stopped, stopped };
};

const runAuxiliarySweeps = async ({
  db, nowMs, budgets, metrics, expectedRolloutRevision, expectedEvidenceDigest,
  allowPausedCanary = false, deadlineReached = () => false, resumeRequeue = null,
// eslint-disable-next-line complexity -- each bounded sweep has an independent authorization/deadline gate
}) => {
  const results = [];
  let rolloutChanged = false;
  let deadlineExceeded = false;
  const withinDeadline = async () => {
    deadlineExceeded = deadlineExceeded || deadlineReached();
    return !deadlineExceeded;
  };
  const authorize = async () => {
    if (!(await withinDeadline())) return false;
    const authorized = await rolloutAuthorizesCompactor({
      db, expectedRolloutRevision, metrics, expectedEvidenceDigest, allowPausedCanary,
    });
    rolloutChanged = rolloutChanged || !authorized;
    return authorized;
  };
  const terminalRepair = await sweepTerminalSchedulingRepair({
    db, nowMs, budgets, metrics, startPage: authorize, canContinue: withinDeadline,
  });
  results.push(terminalRepair.hasMore);
  if (terminalRepair.stopped || rolloutChanged || deadlineExceeded) {
    return { hasMore: true, rolloutChanged, deadlineExceeded };
  }
  let orphanHasMore = false;
  for (let page = 0; page < budgets.maxOrphanPages; page += 1) {
    if (!(await authorize())) {
      orphanHasMore = true;
      break;
    }
    const orphan = await sweepOrphanAttempts({
      db, nowMs, budgets, metrics, canContinue: withinDeadline,
    });
    orphanHasMore = orphan.hasMore;
    if (orphan.stopped || !orphan.hasMore) break;
  }
  results.push(orphanHasMore);
  if (rolloutChanged || deadlineExceeded || !(await authorize())) {
    return { hasMore: true, rolloutChanged, deadlineExceeded };
  }
  const requeueRecovery = await sweepDueRequeueRecovery({
    db, nowMs, budgets, metrics, resumeRequeue,
    startPage: authorize, canContinue: withinDeadline,
    expectedRolloutRevision, expectedEvidenceDigest,
  });
  results.push(requeueRecovery.hasMore);
  if (requeueRecovery.stopped || rolloutChanged || deadlineExceeded) {
    return { hasMore: true, rolloutChanged, deadlineExceeded };
  }
  results.push(await runExactExpirySweep({
    db,
    root: 'notification_audience_previews',
    orderField: 'expiresAtMs',
    nowMs,
    limit: budgets.auxiliaryPageSize,
    maxPages: budgets.maxAuxiliaryPages,
    metrics,
    metricName: 'previewsDeleted',
    startPage: authorize,
    canContinue: withinDeadline,
  }));
  if (rolloutChanged || deadlineExceeded || !(await authorize())) {
    return { hasMore: true, rolloutChanged, deadlineExceeded };
  }
  results.push(await runExactExpirySweep({
    db,
    root: 'notification_requeue_jobs',
    orderField: 'expiresAtMs',
    nowMs,
    limit: budgets.auxiliaryPageSize,
    maxPages: budgets.maxAuxiliaryPages,
    metrics,
    metricName: 'requeueJobsDeleted',
    cleanupExpired: ({ db: targetDb, key, expected, nowMs: targetNowMs }) => (
      cleanupExpiredNotificationRequeueState({
        db: targetDb, jobId: key, expected, nowMs: targetNowMs,
      })
    ),
    startPage: authorize,
    canContinue: withinDeadline,
  }));
  if (rolloutChanged || deadlineExceeded || !(await authorize())) {
    return { hasMore: true, rolloutChanged, deadlineExceeded };
  }
  const marketing = await sweepOrphanMarketingDetails({
    db, nowMs, budgets, metrics, canContinue: withinDeadline, startPage: authorize,
    expectedRolloutRevision, expectedEvidenceDigest,
  });
  results.push(marketing.hasMore);
  return {
    hasMore: results.some(Boolean),
    rolloutChanged,
    deadlineExceeded: deadlineExceeded || marketing.stopped,
  };
};

module.exports = { runAuxiliarySweeps };
