'use strict';

// @ts-check

const {
  DASHBOARD_ROOT,
  DASHBOARD_SCHEMA_VERSION,
  fingerprint,
} = require('./dashboardProjection');

const COUNT_LOCK_TTL_MS = 30_000;
const COUNT_LOCK_ATTEMPTS = 20;
const COUNT_LOCK_RETRY_MAX_MS = 250;
const CONSISTENT_SUMMARY_PROTOCOL_VERSION = 2;
const SUMMARY_GENERATION_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SUMMARY_DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isValidSummaryDayKey = (value) => {
  const match = SUMMARY_DAY_KEY_PATTERN.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const normalizeSummaryGeneration = ({
  generationKey,
  generationStartDayKey,
  generationEndDayKey,
}) => {
  const hasDayRange = generationStartDayKey !== undefined || generationEndDayKey !== undefined;
  if (hasDayRange) {
    if (!isValidSummaryDayKey(generationStartDayKey)
      || !isValidSummaryDayKey(generationEndDayKey)
      || generationStartDayKey > generationEndDayKey) {
      throw new TypeError('Dashboard summary generation must be a valid ordered day range');
    }
    const compoundKey = `${generationStartDayKey}..${generationEndDayKey}`;
    if (generationKey !== undefined && generationKey !== compoundKey) {
      throw new TypeError('Dashboard summary generation key does not match its day range');
    }
    return {
      kind: 'day-range',
      key: compoundKey,
      startDayKey: generationStartDayKey,
      endDayKey: generationEndDayKey,
    };
  }
  if (!SUMMARY_GENERATION_KEY_PATTERN.test(String(generationKey || ''))) {
    throw new TypeError('Dashboard summary fixed generation key is invalid');
  }
  return { kind: 'fixed', key: generationKey };
};

const compareSummaryGenerations = (left, right) => {
  if (left.kind !== right.kind) {
    throw new TypeError('Dashboard summary generation kinds do not match');
  }
  if (left.kind === 'day-range') {
    return left.startDayKey.localeCompare(right.startDayKey)
      || left.endDayKey.localeCompare(right.endDayKey);
  }
  return left.key.localeCompare(right.key);
};

const normalizeSummarySourceRevision = (value) => {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('Dashboard summary source revision must be a non-negative safe integer');
  }
  return revision;
};

const eventOrder = (event) => ({
  sourceEventAtMs: Number.isFinite(Date.parse(event?.time || '')) ? Date.parse(event.time) : Date.now(),
  sourceEventId: String(event?.id || ''),
});

const compareEventOrder = (left = {}, right = {}) => {
  const timeDelta = Number(left.sourceEventAtMs || 0) - Number(right.sourceEventAtMs || 0);
  return timeDelta || String(left.sourceEventId || '').localeCompare(String(right.sourceEventId || ''));
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
};

const readValue = async (db, path, instrumentation) => {
  if (instrumentation) instrumentation.directReads = Number(instrumentation.directReads || 0) + 1;
  const snapshot = await db.ref(path).once('value');
  return snapshot.val();
};

const commitSummaryDomain = async ({ db, domain, revision, fields, nowMs }) => {
  const revisionField = `${domain}Revision`;
  const updatedAtField = `${domain}UpdatedAtMs`;
  const result = await db.ref(`${DASHBOARD_ROOT}/summary`).transaction((current) => {
    if (Number(current?.[revisionField] || 0) > Number(revision || 0)) return current;
    return {
      ...(current || {}),
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      ...fields,
      [revisionField]: Number(revision || 0),
      [updatedAtField]: Math.max(Number(current?.[updatedAtField] || 0), Number(nowMs || 0)),
    };
  }, undefined, false);
  return result.snapshot?.val?.() || null;
};

const commitConsistentSummaryDomain = async ({
  db,
  domain,
  generationKey,
  generationStartDayKey,
  generationEndDayKey,
  sourceRevision,
  sourceFingerprint,
  fields,
  nowMs,
}) => {
  const revisionField = `${domain}Revision`;
  const sourceRevisionField = `${domain}SourceRevision`;
  const generationKeyField = `${domain}GenerationKey`;
  const generationStartField = `${domain}GenerationStartDayKey`;
  const generationEndField = `${domain}GenerationEndDayKey`;
  const fingerprintField = `${domain}Fingerprint`;
  const protocolField = `${domain}ConsistencyProtocol`;
  const updatedAtField = `${domain}UpdatedAtMs`;
  const candidateGeneration = normalizeSummaryGeneration({
    generationKey,
    generationStartDayKey,
    generationEndDayKey,
  });
  const candidateRevision = normalizeSummarySourceRevision(sourceRevision);
  if (typeof sourceFingerprint !== 'string' || !sourceFingerprint) {
    throw new TypeError('Dashboard summary source fingerprint is required');
  }
  let outcome = 'pending';
  const result = await db.ref(`${DASHBOARD_ROOT}/summary`).transaction((current) => {
    if (current?.[protocolField] === CONSISTENT_SUMMARY_PROTOCOL_VERSION) {
      let currentGeneration;
      let currentRevision;
      try {
        currentGeneration = normalizeSummaryGeneration({
          generationKey: current[generationKeyField],
          generationStartDayKey: current[generationStartField],
          generationEndDayKey: current[generationEndField],
        });
        currentRevision = normalizeSummarySourceRevision(current[sourceRevisionField]);
        if (typeof current[fingerprintField] !== 'string' || !current[fingerprintField]) {
          throw new TypeError('Dashboard summary stored fingerprint is invalid');
        }
      } catch (_error) {
        outcome = 'inconsistent';
        return undefined;
      }
      let generationOrder;
      try {
        generationOrder = compareSummaryGenerations(currentGeneration, candidateGeneration);
      } catch (_error) {
        outcome = 'inconsistent';
        return undefined;
      }
      if (generationOrder > 0) {
        outcome = 'stale';
        return current;
      }
      if (generationOrder < 0) {
        outcome = 'applied';
      } else if (currentRevision > candidateRevision) {
        outcome = 'stale';
        return current;
      } else if (currentRevision === candidateRevision) {
        if (current[fingerprintField] === sourceFingerprint) {
          outcome = 'idempotent';
          return current;
        }
        outcome = 'inconsistent';
        return undefined;
      }
    }
    if (outcome !== 'applied') {
      outcome = 'applied';
    }
    return {
      ...(current || {}),
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      ...fields,
      [revisionField]: candidateRevision,
      [sourceRevisionField]: candidateRevision,
      [generationKeyField]: candidateGeneration.key,
      ...(candidateGeneration.kind === 'day-range' ? {
        [generationStartField]: candidateGeneration.startDayKey,
        [generationEndField]: candidateGeneration.endDayKey,
      } : {}),
      [fingerprintField]: sourceFingerprint,
      [protocolField]: CONSISTENT_SUMMARY_PROTOCOL_VERSION,
      [updatedAtField]: Math.max(Number(current?.[updatedAtField] || 0), Number(nowMs || 0)),
    };
  }, undefined, false);
  if (outcome === 'inconsistent') {
    const error = new Error(`Dashboard ${domain} summary is inconsistent at generation ${candidateGeneration.key} revision ${candidateRevision}`);
    error.code = 'DASHBOARD_SUMMARY_INCONSISTENT';
    error.domain = domain;
    error.generationKey = candidateGeneration.key;
    error.sourceRevision = candidateRevision;
    error.revision = candidateRevision;
    throw error;
  }
  return { outcome, value: result.snapshot?.val?.() || null };
};

const commitTourProjectionCompletion = async ({
  db,
  tourId,
  projectionRevision,
  sourceFingerprint,
  completedAtMs = Date.now(),
}) => {
  const candidateRevision = Number(projectionRevision || 0);
  let outcome = 'pending';
  const result = await db.ref(
    `${DASHBOARD_ROOT}/internal/tour_projection_completion/${tourId}`,
  ).transaction((current) => {
    const currentRevision = Number(current?.projectionRevision || 0);
    if (current && currentRevision > candidateRevision) {
      outcome = 'stale';
      return current;
    }
    if (current && currentRevision === candidateRevision) {
      if (current.sourceFingerprint === sourceFingerprint) {
        outcome = 'idempotent';
        return current;
      }
      outcome = 'inconsistent';
      return undefined;
    }
    outcome = 'applied';
    return {
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      projectionRevision: candidateRevision,
      sourceFingerprint,
      completedAtMs: Number(completedAtMs || 0),
    };
  }, undefined, false);
  if (outcome === 'inconsistent') {
    const error = new Error(`Dashboard tour completion conflicts at revision ${candidateRevision}`);
    error.code = 'DASHBOARD_COMPLETION_INCONSISTENT';
    error.tourId = tourId;
    error.revision = candidateRevision;
    throw error;
  }
  return { outcome, value: result.snapshot?.val?.() || null };
};

const makeTombstone = (identity, order) => ({
  schemaVersion: DASHBOARD_SCHEMA_VERSION,
  ...identity,
  deleted: true,
  sourceFingerprint: 'deleted',
  ...order,
  sourceUpdatedAtMs: order.sourceEventAtMs,
  projectedAtMs: Date.now(),
});

const commitCompareSafeProjection = async ({ projectionRef, projection, identity, order }) => {
  let applied = false;
  let previous = null;
  const candidate = projection || makeTombstone(identity, order);
  const result = await projectionRef.transaction((current) => {
    previous = current || null;
    if (current && compareEventOrder(current, order) > 0) return current;
    if (current?.sourceFingerprint === candidate.sourceFingerprint
      && Boolean(current?.deleted) === Boolean(candidate.deleted)) {
      if (compareEventOrder(current, order) === 0) return current;
      return {
        ...current,
        ...order,
        sourceUpdatedAtMs: order.sourceEventAtMs,
        projectedAtMs: Date.now(),
      };
    }
    applied = true;
    return {
      ...candidate,
      ...order,
      sourceUpdatedAtMs: order.sourceEventAtMs,
      projectedAtMs: Date.now(),
      projectionRevision: Number(current?.projectionRevision || 0) + 1,
    };
  }, undefined, false);
  return { applied: result.committed && applied, previous, current: result.snapshot?.val?.() || null };
};

const commitCompareSafePublicProjection = async ({
  projectionRef,
  watermarkRef,
  projection,
  order,
  refreshProjection,
}) => { // eslint-disable-line complexity -- compare-safe repair loop keeps ordering and deletion atomic
  let accepted = false;
  const desiredFingerprint = projection?.sourceFingerprint || 'deleted';
  const watermarkResult = await watermarkRef.transaction((current) => {
    if (current && compareEventOrder(current, order) > 0) return current;
    accepted = true;
    return {
      ...order,
      sourceFingerprint: desiredFingerprint,
      projectionRevision: Number(current?.projectionRevision || 0) + 1,
    };
  }, undefined, false);
  if (!accepted) return { applied: false, stale: true };

  let desired = projection;
  let expected = watermarkResult.snapshot?.val?.() || { ...order, sourceFingerprint: desiredFingerprint };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await projectionRef.set(desired ? {
      ...desired,
      projectionRevision: Number(expected.projectionRevision || 1),
      sourceUpdatedAtMs: Number(expected.sourceEventAtMs || 0),
      projectedAtMs: Date.now(),
    } : null);
    const latest = (await watermarkRef.once('value')).val() || {};
    if (compareEventOrder(latest, expected) === 0
      && latest.sourceFingerprint === expected.sourceFingerprint) {
      return { applied: true, deleted: !desired };
    }
    desired = await refreshProjection();
    expected = { ...latest, sourceFingerprint: desired?.sourceFingerprint || 'deleted' };
    const stillLatest = (await watermarkRef.once('value')).val() || {};
    if (compareEventOrder(stillLatest, latest) !== 0) continue;
    if (stillLatest.sourceFingerprint !== expected.sourceFingerprint) continue;
  }
  const error = new Error('Dashboard public projection changed during reconciliation');
  error.code = 'DASHBOARD_PROJECTION_RACE';
  throw error;
};

const acquireCountLock = async ({ db, lockPath, owner }) => {
  for (let attempt = 0; attempt < COUNT_LOCK_ATTEMPTS; attempt += 1) {
    const lockNowMs = Date.now();
    const result = await db.ref(lockPath).transaction((current) => {
      if (current?.expiresAtMs > lockNowMs) return undefined;
      return { owner, expiresAtMs: lockNowMs + COUNT_LOCK_TTL_MS };
    }, undefined, false);
    if (result.committed) return true;
    if (attempt < COUNT_LOCK_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(COUNT_LOCK_RETRY_MAX_MS, (attempt + 1) * 25),
      ));
    }
  }
  return false;
};

const releaseCountLock = ({ db, lockPath, owner }) => db.ref(lockPath)
  .transaction((current) => (current?.owner === owner ? null : current), undefined, false);

const reconcileAggregateContribution = async ({
  db,
  type,
  scopeId,
  memberId,
  owner,
  nowMs,
  loadCurrentContribution,
  aggregatePath,
}) => {
  const memberHash = fingerprint({ memberId });
  const lockPath = `${DASHBOARD_ROOT}/internal/count_locks/${type}/${scopeId}`;
  const contributionPath = `${DASHBOARD_ROOT}/internal/count_contributions/${type}/${scopeId}/${memberHash}`;
  if (!(await acquireCountLock({ db, lockPath, owner }))) {
    const error = new Error('Dashboard count reconciliation is already in progress');
    error.code = 'DASHBOARD_COUNT_LOCKED';
    throw error;
  }
  try {
    const [nextContribution, previousContribution, aggregate] = await Promise.all([
      loadCurrentContribution(),
      readValue(db, contributionPath),
      readValue(db, aggregatePath),
    ]);
    const before = previousContribution && typeof previousContribution === 'object' ? previousContribution : {};
    const after = nextContribution && typeof nextContribution === 'object' ? nextContribution : {};
    const currentAggregate = aggregate && typeof aggregate === 'object' ? aggregate : {};
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((field) => !['schemaVersion', 'updatedAtMs', 'backfillGeneration'].includes(field));
    const nextAggregate = { ...currentAggregate };
    fields.forEach((field) => {
      nextAggregate[field] = Math.max(0, Number(currentAggregate[field] || 0)
        + Number(after[field] || 0) - Number(before[field] || 0));
    });
    nextAggregate.schemaVersion = DASHBOARD_SCHEMA_VERSION;
    nextAggregate.revision = Number(currentAggregate.revision || 0) + 1;
    nextAggregate.updatedAtMs = Math.max(Number(currentAggregate.updatedAtMs || 0), Number(nowMs || 0));
    await db.ref().update({
      [contributionPath]: Object.keys(after).length ? {
        ...after,
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        updatedAtMs: Math.max(Number(before.updatedAtMs || 0), Number(nowMs || 0)),
      } : null,
      [aggregatePath]: nextAggregate,
    });
    return nextAggregate;
  } finally {
    await releaseCountLock({ db, lockPath, owner });
  }
};

module.exports = {
  acquireCountLock,
  commitCompareSafeProjection,
  commitCompareSafePublicProjection,
  commitConsistentSummaryDomain,
  commitSummaryDomain,
  commitTourProjectionCompletion,
  eventOrder,
  mapWithConcurrency,
  readValue,
  reconcileAggregateContribution,
  releaseCountLock,
};
