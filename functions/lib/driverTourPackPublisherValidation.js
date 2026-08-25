'use strict';

const { createHash } = require('crypto');
const { assertValidDriverTourPack, canonicalJson } = require('./driverTourPackSchema');

const DRIVER_TOUR_PACK_ROOTS = Object.freeze({
  packs: 'driver_tour_packs',
  tombstones: 'driver_tour_pack_tombstones',
  ingestion: 'driver_tour_pack_ingestion',
  adminStatus: 'driver_tour_pack_admin_status',
});
const ALLOWED_WRITE_ROOTS = new Set(Object.values(DRIVER_TOUR_PACK_ROOTS));
const INGESTION_LIMITS = Object.freeze({
  maxBodyBytes: 2_000_000,
  maxPacksPerRun: 1_000,
  maxPacksPerBatch: 25,
  maxBatchesPerRun: 40,
  maxRunIdLength: 100,
  leaseMs: 10 * 60 * 1_000,
});
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

class DriverTourPackPublisherError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DriverTourPackPublisherError';
    this.code = code;
    this.status = status;
  }
}

function normalizeBeginRequest(body) {
  exactRequest(body, ['action', 'runId', 'sourceSnapshotDate', 'startedAtMs', 'batchCount', 'inventory', 'aggregateFingerprint']);
  const runId = validateRunId(body.runId);
  if (!isRealDateString(body.sourceSnapshotDate)) throw publisherError('INVALID_SOURCE_DATE', 'sourceSnapshotDate must be a real YYYY-MM-DD date.');
  if (!Number.isSafeInteger(body.startedAtMs) || body.startedAtMs < 0) throw publisherError('INVALID_STARTED_AT', 'startedAtMs must be a non-negative safe integer.');
  if (!Array.isArray(body.inventory) || !body.inventory.length || body.inventory.length > INGESTION_LIMITS.maxPacksPerRun) {
    throw publisherError('INVALID_INVENTORY_SIZE', `inventory must contain 1-${INGESTION_LIMITS.maxPacksPerRun} packs.`);
  }
  if (!Number.isSafeInteger(body.batchCount) || body.batchCount < 1 || body.batchCount > INGESTION_LIMITS.maxBatchesPerRun) {
    throw publisherError('INVALID_BATCH_COUNT', 'batchCount is outside the allowed range.');
  }
  const minimumBatches = Math.ceil(body.inventory.length / INGESTION_LIMITS.maxPacksPerBatch);
  if (body.batchCount < minimumBatches || body.batchCount > body.inventory.length) {
    throw publisherError('INVALID_BATCH_COUNT', 'batchCount cannot hold the inventory or contains empty batches.');
  }
  const inventory = body.inventory.map(normalizeDescriptor).sort(compareDepartureKey);
  if (new Set(inventory.map((item) => item.departureKey)).size !== inventory.length) {
    throw publisherError('DUPLICATE_DEPARTURE', 'inventory contains a duplicate departureKey.');
  }
  const aggregateFingerprint = hashValue(inventory);
  if (body.aggregateFingerprint !== aggregateFingerprint) {
    throw publisherError('AGGREGATE_FINGERPRINT_MISMATCH', 'aggregateFingerprint does not match inventory.');
  }
  return {
    action: 'begin',
    runId,
    sourceSnapshotDate: body.sourceSnapshotDate,
    startedAtMs: body.startedAtMs,
    batchCount: body.batchCount,
    inventory,
    aggregateFingerprint,
  };
}

function normalizeUploadRequest(body) {
  exactRequest(body, ['action', 'runId', 'batchIndex', 'packs', 'batchFingerprint']);
  const runId = validateRunId(body.runId);
  if (!Number.isSafeInteger(body.batchIndex) || body.batchIndex < 0) throw publisherError('INVALID_BATCH_INDEX', 'batchIndex must be non-negative.');
  if (!Array.isArray(body.packs) || !body.packs.length || body.packs.length > INGESTION_LIMITS.maxPacksPerBatch) {
    throw publisherError('INVALID_BATCH_SIZE', `packs must contain 1-${INGESTION_LIMITS.maxPacksPerBatch} entries.`);
  }
  validateFingerprint(body.batchFingerprint, 'batchFingerprint');
  return { action: 'upload', runId, batchIndex: body.batchIndex, packs: body.packs, batchFingerprint: body.batchFingerprint };
}

function normalizeFinalizeRequest(body) {
  exactRequest(body, ['action', 'runId', 'aggregateFingerprint']);
  const runId = validateRunId(body.runId);
  validateFingerprint(body.aggregateFingerprint, 'aggregateFingerprint');
  return { action: 'finalize', runId, aggregateFingerprint: body.aggregateFingerprint };
}

function normalizeDescriptor(value) {
  exactRequest(value, ['departureKey', 'tourId', 'tourCode', 'dateISO', 'status', 'contentFingerprint']);
  if (!isSafeFirebaseKey(value.departureKey, 180) || !isSafeFirebaseKey(value.tourId, 100)) {
    throw publisherError('INVALID_DEPARTURE_IDENTITY', 'Descriptor identity is not Firebase-safe.');
  }
  if (!isRealDateString(value.dateISO) || value.departureKey !== `${value.dateISO}::${value.tourId}`) {
    throw publisherError('INVALID_DEPARTURE_IDENTITY', 'Descriptor departureKey must equal dateISO::tourId.');
  }
  if (typeof value.tourCode !== 'string' || !value.tourCode.trim() || value.tourCode.length > 100) {
    throw publisherError('INVALID_TOUR_CODE', 'Descriptor tourCode is invalid.');
  }
  if (!['active', 'cancelled', 'withdrawn'].includes(value.status)) throw publisherError('INVALID_PACK_STATUS', 'Descriptor status is invalid.');
  validateFingerprint(value.contentFingerprint, 'contentFingerprint');
  return { ...value };
}

function validatePackAgainstRun(pack, run) {
  try {
    assertValidDriverTourPack(pack);
  } catch (error) {
    throw publisherError('PACK_SCHEMA_INVALID', error.message);
  }
  const inventory = run.inventory?.[pack.departureKey];
  const plan = run.plan?.[pack.departureKey];
  if (!inventory || !plan) throw publisherError('PACK_NOT_DECLARED', 'The pack was not declared in begin.', 409);
  if (pack.sourceSnapshotDate !== run.sourceSnapshotDate) {
    throw publisherError('PACK_SOURCE_SNAPSHOT_MISMATCH', 'The pack source snapshot differs from the declared run.', 409);
  }
  const descriptor = packDescriptor(pack);
  if (canonicalJson(descriptor) !== canonicalJson(inventory)) {
    throw publisherError('PACK_DESCRIPTOR_MISMATCH', 'The pack does not match its declared descriptor.', 409);
  }
  if (pack.revision !== plan.revision || pack.publishedAtMs !== plan.publishedAtMs) {
    throw publisherError('PACK_PUBLICATION_PLAN_MISMATCH', 'The pack revision metadata differs from the server plan.', 409);
  }
  return pack;
}


function assertRunIsFresh(request, latest, { allowSameRun = false } = {}) {
  if (!latest) return;
  if (allowSameRun && latest.runId === request.runId) return;
  if (String(request.sourceSnapshotDate) < String(latest.sourceSnapshotDate || '')) {
    throw publisherError('STALE_RUN', 'The source snapshot is older than the latest successful publication.', 409);
  }
  if (Number(request.startedAtMs) <= Number(latest.startedAtMs || 0)) {
    throw publisherError('STALE_RUN', 'The run started before the latest successful publication.', 409);
  }
}

function beginResponse(run, idempotent) {
  return {
    ok: true,
    action: 'begin',
    runId: run.runId,
    sourceSnapshotDate: run.sourceSnapshotDate,
    expectedPackCount: run.expectedPackCount,
    expectedBatchCount: run.expectedBatchCount,
    aggregateFingerprint: run.aggregateFingerprint,
    plan: Object.values(run.plan || {}).sort(compareDepartureKey),
    idempotent,
  };
}

function packDescriptor(pack) {
  return {
    departureKey: pack.departureKey,
    tourId: pack.tourId,
    tourCode: pack.tourCode,
    dateISO: pack.dateISO,
    status: pack.status,
    contentFingerprint: pack.contentFingerprint,
  };
}

function fingerprintPackBatch(packs) {
  const evidence = packs.map((pack) => ({
    ...packDescriptor(pack),
    revision: pack.revision,
    publishedAtMs: pack.publishedAtMs,
  })).sort(compareDepartureKey);
  return hashValue(evidence);
}

function assertWriteRoots(updates) {
  Object.keys(updates).forEach((path) => {
    const root = String(path).split('/')[0];
    if (!ALLOWED_WRITE_ROOTS.has(root)) throw new Error(`Publisher attempted a write outside its roots: ${root}`);
  });
}

function assertBodySize(body) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    throw publisherError('INVALID_BODY', 'The request body is not valid JSON data.');
  }
  if (bytes > INGESTION_LIMITS.maxBodyBytes) throw publisherError('BODY_TOO_LARGE', 'The request body exceeds the ingestion limit.', 413);
}

function exactRequest(value, keys) {
  if (!isObject(value)) throw publisherError('INVALID_BODY', 'A JSON object is required.');
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) throw publisherError('INVALID_BODY_FIELDS', 'The request contains missing or unknown fields.');
}

function validateRunId(value) {
  if (typeof value !== 'string' || !value || value.length > INGESTION_LIMITS.maxRunIdLength || !RUN_ID_PATTERN.test(value)) {
    throw publisherError('INVALID_RUN_ID', 'runId is invalid.');
  }
  return value;
}

function validateFingerprint(value, field) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) throw publisherError('INVALID_FINGERPRINT', `${field} is invalid.`);
}

function isSafeFirebaseKey(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint > 31 && codePoint !== 127 && !'.#$/[]'.includes(character);
    });
}

function isRealDateString(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function hashValue(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function compareDepartureKey(left, right) {
  return String(left.departureKey || '').localeCompare(String(right.departureKey || ''));
}


function positiveOrOne(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function nonNegativeOr(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function publisherError(code, message, status = 400) {
  return new DriverTourPackPublisherError(code, message, status);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  DRIVER_TOUR_PACK_ROOTS,
  INGESTION_LIMITS,
  DriverTourPackPublisherError,
  assertBodySize,
  assertRunIsFresh,
  assertWriteRoots,
  beginResponse,
  compareDepartureKey,
  exactRequest,
  fingerprintPackBatch,
  hashValue,
  isObject,
  isRealDateString,
  isSafeFirebaseKey,
  nonNegativeOr,
  normalizeBeginRequest,
  normalizeDescriptor,
  normalizeFinalizeRequest,
  normalizeUploadRequest,
  packDescriptor,
  positiveOrOne,
  publisherError,
  validateFingerprint,
  validatePackAgainstRun,
  validateRunId,
};
