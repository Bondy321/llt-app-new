'use strict';

const {
  DRIVER_TOUR_PACK_ROOTS,
  INGESTION_LIMITS,
  DriverTourPackPublisherError,
  assertBodySize,
  assertRunIsFresh,
  assertWriteRoots,
  beginResponse,
  compareDepartureKey,
  fingerprintPackBatch,
  hashValue,
  isObject,
  nonNegativeOr,
  normalizeBeginRequest,
  normalizeFinalizeRequest,
  normalizeUploadRequest,
  packDescriptor,
  positiveOrOne,
  publisherError,
  validatePackAgainstRun,
} = require('./driverTourPackPublisherValidation');
const { rehydrateDriverTourPackFromFirebase } = require('./driverTourPackSchema');

function createDriverTourPackPublisher({ database, now = () => Date.now() } = {}) {
  if (!database || typeof database.ref !== 'function') throw new TypeError('A Realtime Database instance is required.');

  return {
    handle: async (body) => {
      assertBodySize(body);
      if (!isObject(body)) throw publisherError('INVALID_BODY', 'A JSON object body is required.');
      switch (body.action) {
        case 'begin': return beginRun({ database, now, body });
        case 'upload': return uploadBatch({ database, now, body });
        case 'finalize': return finalizeRun({ database, now, body });
        default: throw publisherError('INVALID_ACTION', 'action must be begin, upload or finalize.');
      }
    },
  };
}

async function beginRun({ database, now, body }) {
  const request = normalizeBeginRequest(body);
  const runPath = `${DRIVER_TOUR_PACK_ROOTS.ingestion}/runs/${request.runId}`;
  const existingRun = await readValue(database, runPath);
  const requestHash = hashValue(request);
  if (existingRun) {
    if (existingRun.requestHash !== requestHash) {
      throw publisherError('RUN_REPLAY_CONFLICT', 'The run ID was already used with different input.', 409);
    }
    if (existingRun.status === 'FINALIZED') {
      return { ...existingRun.result, idempotent: true };
    }
    await acquireRunLease(database, request.runId, request.startedAtMs, now());
    return beginResponse(existingRun, true);
  }

  await acquireRunLease(database, request.runId, request.startedAtMs, now());
  try {
    const latest = await readValue(database, `${DRIVER_TOUR_PACK_ROOTS.ingestion}/latestSuccessfulRun`);
    assertRunIsFresh(request, latest);
    const metadata = await readValue(database, `${DRIVER_TOUR_PACK_ROOTS.ingestion}/packMetadata`) || {};
    const plannedAtMs = now();
    const plan = Object.fromEntries(request.inventory.map((descriptor) => {
      const current = metadata[descriptor.departureKey] || null;
      const unchanged = Boolean(
        current
        && current.contentFingerprint === descriptor.contentFingerprint
        && current.status === descriptor.status
      );
      const action = unchanged
        ? 'noop'
        : descriptor.status === 'active'
          ? current ? 'update' : 'create'
          : 'tombstone';
      return [descriptor.departureKey, {
        departureKey: descriptor.departureKey,
        revision: unchanged ? positiveOrOne(current.revision) : positiveOrOne(current?.revision) + (current ? 1 : 0),
        publishedAtMs: unchanged ? nonNegativeOr(current.publishedAtMs, plannedAtMs) : plannedAtMs,
        action,
      }];
    }));
    const run = {
      schemaVersion: 1,
      runId: request.runId,
      status: 'BEGUN',
      requestHash,
      sourceSnapshotDate: request.sourceSnapshotDate,
      startedAtMs: request.startedAtMs,
      createdAtMs: plannedAtMs,
      updatedAtMs: plannedAtMs,
      expectedPackCount: request.inventory.length,
      expectedBatchCount: request.batchCount,
      aggregateFingerprint: request.aggregateFingerprint,
      inventory: Object.fromEntries(request.inventory.map((descriptor) => [descriptor.departureKey, descriptor])),
      plan,
      batchClaims: {},
      departureClaims: {},
      batches: {},
    };
    await database.ref(runPath).set(run);
    return beginResponse(run, false);
  } catch (error) {
    await releaseRunLease(database, request.runId).catch(() => {});
    throw error;
  }
}

async function uploadBatch({ database, now, body }) {
  const request = normalizeUploadRequest(body);
  const runPath = `${DRIVER_TOUR_PACK_ROOTS.ingestion}/runs/${request.runId}`;
  const existingRun = await readValue(database, runPath);
  if (existingRun?.status === 'FINALIZED') {
    const previousBatch = existingRun.batches?.[request.batchIndex];
    if (previousBatch?.batchFingerprint !== request.batchFingerprint) {
      throw publisherError('BATCH_REPLAY_CONFLICT', 'The finalized batch differs from this retry.', 409);
    }
    return {
      ok: true,
      action: 'upload',
      runId: request.runId,
      batchIndex: request.batchIndex,
      packCount: previousBatch.packCount,
      batchFingerprint: request.batchFingerprint,
      idempotent: true,
    };
  }
  const run = await requireOpenRun(database, request.runId, existingRun);
  if (request.batchIndex >= run.expectedBatchCount) {
    throw publisherError('BATCH_INDEX_OUT_OF_RANGE', 'batchIndex exceeds the declared run batch count.');
  }
  const normalizedPacks = request.packs.map((pack) => validatePackAgainstRun(pack, run));
  const batchFingerprint = fingerprintPackBatch(normalizedPacks);
  if (batchFingerprint !== request.batchFingerprint) {
    throw publisherError('BATCH_FINGERPRINT_MISMATCH', 'The batch fingerprint does not match the validated packs.');
  }

  await requireActiveLease(database, request.runId, now());
  let claimConflict = null;
  const claimResult = await database.ref(runPath).transaction((current) => {
    // RTDB transactions may invoke the updater once with an empty local cache before
    // retrying with the authoritative server value. Seed that speculative pass with
    // the run we just read; the server-side compare-and-set still resolves every
    // concurrent batch against its current value before committing.
    const currentRun = current || run;
    if (!['BEGUN', 'UPLOADING'].includes(currentRun.status)) {
      claimConflict = 'RUN_NOT_OPEN';
      return undefined;
    }
    const batchKey = String(request.batchIndex);
    const existingClaim = currentRun.batchClaims?.[batchKey];
    if (existingClaim && existingClaim !== batchFingerprint) {
      claimConflict = 'BATCH_REPLAY_CONFLICT';
      return undefined;
    }
    const departureClaims = { ...(currentRun.departureClaims || {}) };
    for (const pack of normalizedPacks) {
      const claimedBatch = departureClaims[pack.departureKey];
      if (claimedBatch !== undefined && claimedBatch !== request.batchIndex) {
        claimConflict = 'DEPARTURE_BATCH_CONFLICT';
        return undefined;
      }
      departureClaims[pack.departureKey] = request.batchIndex;
    }
    return {
      ...currentRun,
      status: 'UPLOADING',
      updatedAtMs: now(),
      batchClaims: { ...(currentRun.batchClaims || {}), [batchKey]: batchFingerprint },
      departureClaims,
    };
  }, undefined, false);
  if (!claimResult?.committed) {
    throw publisherError(claimConflict || 'BATCH_CLAIM_FAILED', 'The batch could not be claimed.', 409);
  }

  const batchPath = `${DRIVER_TOUR_PACK_ROOTS.ingestion}/staging/${request.runId}/batches/${request.batchIndex}`;
  const stagedBatch = {
    batchIndex: request.batchIndex,
    batchFingerprint,
    packCount: normalizedPacks.length,
    packs: Object.fromEntries(normalizedPacks.map((pack) => [pack.departureKey, pack])),
  };
  await database.ref(batchPath).set(stagedBatch);
  await database.ref('/').update({
    [`${runPath}/batches/${request.batchIndex}`]: {
      batchIndex: request.batchIndex,
      batchFingerprint,
      packCount: normalizedPacks.length,
      complete: true,
      uploadedAtMs: now(),
    },
    [`${runPath}/updatedAtMs`]: now(),
  });

  return {
    ok: true,
    action: 'upload',
    runId: request.runId,
    batchIndex: request.batchIndex,
    packCount: normalizedPacks.length,
    batchFingerprint,
    idempotent: Boolean(run.batches?.[request.batchIndex]?.batchFingerprint === batchFingerprint),
  };
}

async function finalizeRun({ database, now, body }) {
  const request = normalizeFinalizeRequest(body);
  const runPath = `${DRIVER_TOUR_PACK_ROOTS.ingestion}/runs/${request.runId}`;
  let run = await readValue(database, runPath);
  if (!run) throw publisherError('RUN_NOT_FOUND', 'The ingestion run does not exist.', 404);
  if (run.aggregateFingerprint !== request.aggregateFingerprint) {
    throw publisherError('RUN_REPLAY_CONFLICT', 'The finalize fingerprint differs from the run.', 409);
  }
  if (run.status === 'FINALIZED') return { ...run.result, idempotent: true };
  const missingBeforeFinalize = Array.from({ length: run.expectedBatchCount }, (_, index) => index)
    .filter((index) => run.batches?.[index]?.complete !== true);
  if (missingBeforeFinalize.length) {
    throw publisherError('RUN_INCOMPLETE', `The run is missing ${missingBeforeFinalize.length} complete batch(es).`, 409);
  }
  await transitionLeaseToFinalizing(database, request.runId, now());
  run = await readValue(database, runPath);

  const missingBatches = Array.from({ length: run.expectedBatchCount }, (_, index) => index)
    .filter((index) => run.batches?.[index]?.complete !== true);
  if (missingBatches.length) {
    throw publisherError('RUN_INCOMPLETE', `The run is missing ${missingBatches.length} complete batch(es).`, 409);
  }

  const stagedBatches = await Promise.all(Array.from({ length: run.expectedBatchCount }, (_, index) => (
    readValue(database, `${DRIVER_TOUR_PACK_ROOTS.ingestion}/staging/${request.runId}/batches/${index}`)
  )));
  const packs = [];
  stagedBatches.forEach((batch, index) => {
    if (!batch || batch.batchFingerprint !== run.batches[index].batchFingerprint) {
      throw publisherError('STAGED_BATCH_INVALID', `Staged batch ${index} is missing or inconsistent.`, 409);
    }
    const batchPacks = Object.values(batch.packs || {})
      .map(rehydrateDriverTourPackFromFirebase)
      .map((pack) => validatePackAgainstRun(pack, run));
    if (batchPacks.length !== batch.packCount || batchPacks.length !== run.batches[index].packCount) {
      throw publisherError('STAGED_BATCH_COUNT_MISMATCH', `Staged batch ${index} has the wrong pack count.`, 409);
    }
    if (fingerprintPackBatch(batchPacks) !== batch.batchFingerprint) {
      throw publisherError('STAGED_BATCH_HASH_MISMATCH', `Staged batch ${index} failed hash validation.`, 409);
    }
    packs.push(...batchPacks);
  });

  const keys = packs.map((pack) => pack.departureKey);
  if (packs.length !== run.expectedPackCount || new Set(keys).size !== packs.length) {
    throw publisherError('RUN_PACK_COUNT_MISMATCH', 'The staged run does not match its declared inventory.', 409);
  }
  if (Object.keys(run.inventory || {}).some((key) => !keys.includes(key))) {
    throw publisherError('RUN_INVENTORY_MISMATCH', 'The staged run is missing declared departures.', 409);
  }
  const descriptors = packs.map(packDescriptor).sort(compareDepartureKey);
  if (hashValue(descriptors) !== run.aggregateFingerprint) {
    throw publisherError('RUN_AGGREGATE_HASH_MISMATCH', 'The staged run aggregate hash does not match.', 409);
  }

  const latest = await readValue(database, `${DRIVER_TOUR_PACK_ROOTS.ingestion}/latestSuccessfulRun`);
  assertRunIsFresh(run, latest, { allowSameRun: true });
  const finalizedAtMs = now();
  const counts = { created: 0, updated: 0, unchanged: 0, tombstones: 0 };
  const updates = {};
  packs.forEach((pack) => {
    const plan = run.plan[pack.departureKey];
    if (plan.action === 'noop') counts.unchanged += 1;
    else if (plan.action === 'create') counts.created += 1;
    else if (plan.action === 'update') counts.updated += 1;
    else counts.tombstones += 1;

    if (plan.action !== 'noop') updates[`${DRIVER_TOUR_PACK_ROOTS.packs}/${pack.departureKey}`] = pack;
    updates[`${DRIVER_TOUR_PACK_ROOTS.ingestion}/packMetadata/${pack.departureKey}`] = {
      schemaVersion: pack.schemaVersion,
      departureKey: pack.departureKey,
      tourId: pack.tourId,
      tourCode: pack.tourCode,
      dateISO: pack.dateISO,
      status: pack.status,
      revision: pack.revision,
      publishedAtMs: pack.publishedAtMs,
      expiresAtMs: pack.expiresAtMs,
      contentFingerprint: pack.contentFingerprint,
      runId: request.runId,
    };
    updates[`${DRIVER_TOUR_PACK_ROOTS.adminStatus}/${pack.departureKey}`] = buildAdminStatus(pack, request.runId);
    if (pack.status === 'active') {
      updates[`${DRIVER_TOUR_PACK_ROOTS.tombstones}/${pack.departureKey}`] = null;
    } else {
      updates[`${DRIVER_TOUR_PACK_ROOTS.tombstones}/${pack.departureKey}`] = {
        schemaVersion: pack.schemaVersion,
        departureKey: pack.departureKey,
        tourId: pack.tourId,
        dateISO: pack.dateISO,
        status: pack.status,
        revision: pack.revision,
        publishedAtMs: pack.publishedAtMs,
        contentFingerprint: pack.contentFingerprint,
      };
    }
  });

  const result = {
    ok: true,
    action: 'finalize',
    runId: request.runId,
    sourceSnapshotDate: run.sourceSnapshotDate,
    packCount: packs.length,
    aggregateFingerprint: run.aggregateFingerprint,
    counts,
    finalizedAtMs,
    idempotent: false,
  };
  updates[runPath] = {
    schemaVersion: 1,
    runId: request.runId,
    status: 'FINALIZED',
    requestHash: run.requestHash,
    sourceSnapshotDate: run.sourceSnapshotDate,
    startedAtMs: run.startedAtMs,
    createdAtMs: run.createdAtMs,
    updatedAtMs: finalizedAtMs,
    finalizedAtMs,
    expectedPackCount: run.expectedPackCount,
    expectedBatchCount: run.expectedBatchCount,
    aggregateFingerprint: run.aggregateFingerprint,
    inventory: run.inventory,
    plan: run.plan,
    batches: run.batches,
    result,
  };
  updates[`${DRIVER_TOUR_PACK_ROOTS.ingestion}/latestSuccessfulRun`] = {
    runId: request.runId,
    sourceSnapshotDate: run.sourceSnapshotDate,
    startedAtMs: run.startedAtMs,
    finalizedAtMs,
    packCount: packs.length,
    aggregateFingerprint: run.aggregateFingerprint,
    counts,
  };
  updates[`${DRIVER_TOUR_PACK_ROOTS.ingestion}/staging/${request.runId}`] = null;
  updates[`${DRIVER_TOUR_PACK_ROOTS.ingestion}/activeRun`] = null;
  assertWriteRoots(updates);
  await database.ref('/').update(updates);
  return result;
}

// This is deliberately a separate root from ingestion metadata. It is the
// only Driver Tour Pack publication data readable by operations admins and is
// constrained to fields needed for dispatch, never operational payloads.
function buildAdminStatus(pack, runId) {
  return {
    schemaVersion: pack.schemaVersion,
    departureKey: pack.departureKey,
    tourId: pack.tourId,
    tourCode: pack.tourCode,
    dateISO: pack.dateISO,
    status: pack.status,
    qualityState: pack.quality.state,
    revision: pack.revision,
    publishedAtMs: pack.publishedAtMs,
    expiresAtMs: pack.expiresAtMs,
    sourceSnapshotDate: pack.sourceSnapshotDate,
    runId,
  };
}

async function requireOpenRun(database, runId, existingRun = undefined) {
  const run = existingRun === undefined
    ? await readValue(database, `${DRIVER_TOUR_PACK_ROOTS.ingestion}/runs/${runId}`)
    : existingRun;
  if (!run) throw publisherError('RUN_NOT_FOUND', 'The ingestion run does not exist.', 404);
  if (run.status === 'FINALIZED') throw publisherError('RUN_ALREADY_FINALIZED', 'The ingestion run is already finalized.', 409);
  if (!['BEGUN', 'UPLOADING'].includes(run.status)) throw publisherError('RUN_NOT_OPEN', 'The ingestion run is not open for uploads.', 409);
  return run;
}

async function acquireRunLease(database, runId, startedAtMs, nowMs) {
  const result = await database.ref(`${DRIVER_TOUR_PACK_ROOTS.ingestion}/activeRun`).transaction((current) => {
    if (current && current.runId !== runId && Number(current.leaseExpiresAtMs || 0) > nowMs) {
      return undefined;
    }
    return { runId, startedAtMs, state: 'ACTIVE', leaseExpiresAtMs: nowMs + INGESTION_LIMITS.leaseMs };
  }, undefined, false);
  if (!result?.committed) throw publisherError('PUBLISHER_BUSY', 'Another ingestion run is active.', 409);
}

async function requireActiveLease(database, runId, nowMs) {
  const active = await readValue(database, `${DRIVER_TOUR_PACK_ROOTS.ingestion}/activeRun`);
  if (!active || active.runId !== runId || active.state !== 'ACTIVE' || Number(active.leaseExpiresAtMs || 0) <= nowMs) {
    throw publisherError('RUN_LEASE_LOST', 'The ingestion run no longer owns the active lease.', 409);
  }
}

async function transitionLeaseToFinalizing(database, runId, nowMs) {
  const existingLease = await readValue(database, `${DRIVER_TOUR_PACK_ROOTS.ingestion}/activeRun`);
  if (!existingLease
    || existingLease.runId !== runId
    || Number(existingLease.leaseExpiresAtMs || 0) <= nowMs) {
    throw publisherError('RUN_LEASE_LOST', 'The ingestion run cannot enter finalization.', 409);
  }
  let conflict = false;
  const result = await database.ref(`${DRIVER_TOUR_PACK_ROOTS.ingestion}/activeRun`).transaction((current) => {
    // As with batch claims, seed an initial empty local-cache callback with the
    // lease that was just read. The server transaction still retries against the
    // authoritative current lease before it can commit FINALIZING.
    const currentLease = current || existingLease;
    if (currentLease.runId !== runId || Number(currentLease.leaseExpiresAtMs || 0) <= nowMs) {
      conflict = true;
      return undefined;
    }
    return { ...currentLease, state: 'FINALIZING', leaseExpiresAtMs: nowMs + INGESTION_LIMITS.leaseMs };
  }, undefined, false);
  if (!result?.committed || conflict) throw publisherError('RUN_LEASE_LOST', 'The ingestion run cannot enter finalization.', 409);
}

async function releaseRunLease(database, runId) {
  await database.ref(`${DRIVER_TOUR_PACK_ROOTS.ingestion}/activeRun`).transaction((current) => (
    current?.runId === runId ? null : current
  ), undefined, false);
}

async function readValue(database, path) {
  const reference = database.ref(path);
  const snapshot = typeof reference.get === 'function' ? await reference.get() : await reference.once('value');
  return snapshot?.val?.() ?? null;
}


module.exports = {
  DRIVER_TOUR_PACK_ROOTS,
  INGESTION_LIMITS,
  DriverTourPackPublisherError,
  createDriverTourPackPublisher,
  normalizeBeginRequest,
  normalizeUploadRequest,
  normalizeFinalizeRequest,
  packDescriptor,
  fingerprintPackBatch,
  hashValue,
  assertWriteRoots,
  buildAdminStatus,
};
