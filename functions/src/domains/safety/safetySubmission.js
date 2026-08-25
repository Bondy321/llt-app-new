'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const {
  normalizeTourKeyForComparison,
  resolveTrimmedString,
} = require('../notifications/notificationPolicy');

const SAFETY_CATEGORIES = new Set([
  'delay', 'incident', 'medical', 'lost_passenger', 'vehicle_issue', 'sos',
  'harassment', 'weather', 'custom',
]);
const SAFETY_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/** @type {(...args: any[]) => any} */
const createSafetySubmissionError = (code, message = code) => {
  const error = /** @type {Error & { code?: string }} */ (new Error(message));
  error.code = code;
  return error;
};

/** @type {(...args: any[]) => any} */
const normalizeSafetyCoordinate = (value, minimum, maximum) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : null;
};

/** @param {any} input */
const normalizeSafetyFields = (input) => ({
  clientEventId: resolveTrimmedString(input.clientEventId),
  tourId: normalizeTourKeyForComparison(input.tourId),
  role: resolveTrimmedString(input.role)?.toLowerCase(),
  category: resolveTrimmedString(input.category)?.toLowerCase(),
  requestedSeverity: resolveTrimmedString(input.severity)?.toLowerCase() || 'medium',
  message: resolveTrimmedString(input.message),
  customMessage: resolveTrimmedString(input.customMessage),
  clientCreatedAtMs: Number(input.clientCreatedAtMs),
});

/** @param {any} fields */
const validateSafetyIdentityFields = (fields) => {
  if (!fields.clientEventId || fields.clientEventId.length > 160 || !isValidFirebaseKey(fields.clientEventId)) {
    throw createSafetySubmissionError('INVALID_EVENT_ID');
  }
  if (!fields.tourId || fields.tourId.length > 160 || !isValidFirebaseKey(fields.tourId)) {
    throw createSafetySubmissionError('INVALID_TOUR');
  }
  if (fields.role !== 'passenger' && fields.role !== 'driver') {
    throw createSafetySubmissionError('INVALID_ROLE');
  }
};

/** @param {any} fields */
const validateSafetyContentFields = (fields) => {
  if (!SAFETY_CATEGORIES.has(fields.category)) throw createSafetySubmissionError('INVALID_CATEGORY');
  if (!SAFETY_SEVERITIES.has(fields.requestedSeverity)) throw createSafetySubmissionError('INVALID_SEVERITY');
  if (!fields.message || fields.message.length > 240) throw createSafetySubmissionError('INVALID_MESSAGE');
  if (fields.customMessage && fields.customMessage.length > 1000) {
    throw createSafetySubmissionError('INVALID_DETAILS');
  }
};

/** @param {number} clientCreatedAtMs @param {number} nowMs */
const validateSafetyClientTime = (clientCreatedAtMs, nowMs) => {
  if (!Number.isFinite(clientCreatedAtMs)
    || clientCreatedAtMs < Date.UTC(2020, 0, 1)
    || clientCreatedAtMs > nowMs + 5 * 60 * 1000) {
    throw createSafetySubmissionError('INVALID_CLIENT_TIME');
  }
};

/** @param {any} rawCoords */
const normalizeSafetyLocation = (rawCoords) => {
  if (rawCoords === null || rawCoords === undefined) return null;
  const latitude = normalizeSafetyCoordinate(rawCoords.latitude, -90, 90);
  const longitude = normalizeSafetyCoordinate(rawCoords.longitude, -180, 180);
  const accuracy = Number(rawCoords.accuracy);
  if (latitude === null || longitude === null || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) {
    throw createSafetySubmissionError('INVALID_LOCATION');
  }
  return { latitude, longitude, accuracy };
};

/** @type {(...args: any[]) => any} */
const normalizeSafetySubmissionInput = (input = {}, nowMs = Date.now()) => {
  const fields = normalizeSafetyFields(input);
  validateSafetyIdentityFields(fields);
  validateSafetyContentFields(fields);
  validateSafetyClientTime(fields.clientCreatedAtMs, nowMs);
  const coords = normalizeSafetyLocation(input.coords);
  const isSOS = fields.category === 'sos';
  const severity = isSOS ? 'critical' : fields.requestedSeverity;
  if (input.isSOS === true && !isSOS) {
    throw createSafetySubmissionError('INVALID_SOS_STATE');
  }

  return {
    clientEventId: fields.clientEventId,
    tourId: fields.tourId,
    role: fields.role,
    category: fields.category,
    severity,
    message: fields.message,
    customMessage: fields.customMessage,
    coords,
    isSOS,
    clientCreatedAtMs: fields.clientCreatedAtMs,
    processedFromQueue: input.processedFromQueue === true,
  };
};

/** @type {(...args: any[]) => any} */
const buildCanonicalSafetyRecord = ({ input, authUid, principalId, nowMs = Date.now() }) => ({
  schemaVersion: 2,
  eventId: input.clientEventId,
  clientEventId: input.clientEventId,
  tourId: input.tourId,
  reporterAuthUid: authUid,
  userId: authUid,
  principalId,
  role: input.role,
  category: input.category,
  severity: input.severity,
  message: input.message,
  customMessage: input.customMessage,
  coords: input.coords,
  isSOS: input.isSOS,
  status: 'pending',
  timestamp: new Date(nowMs).toISOString(),
  timestampMs: nowMs,
  clientCreatedAt: new Date(input.clientCreatedAtMs).toISOString(),
  clientCreatedAtMs: input.clientCreatedAtMs,
  receivedAt: new Date(nowMs).toISOString(),
  receivedAtMs: nowMs,
  processedFromQueue: input.processedFromQueue,
});

/** @type {(...args: any[]) => any} */
const buildSafetySubmissionUpdates = ({ record, lockPath }) => {
  const eventId = record.eventId;
  const updates = {
    [`logs/${record.reporterAuthUid}/safety/${eventId}`]: record,
    [`tours/${record.tourId}/safetyAlerts/${eventId}`]: record,
    [lockPath]: null,
  };
  if (record.isSOS || record.severity === 'critical') {
    updates[`globalSafetyAlerts/${eventId}`] = {
      ...record,
      tourAlertId: `tours/${record.tourId}/safetyAlerts/${eventId}`,
    };
  }
  return updates;
};

/**
 * Rate limiting check (simple implementation)
 */

module.exports = {
  buildCanonicalSafetyRecord,
  buildSafetySubmissionUpdates,
  createSafetySubmissionError,
  normalizeSafetyCoordinate,
  normalizeSafetySubmissionInput,
};
