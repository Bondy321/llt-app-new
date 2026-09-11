'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { authorizeAppSessionMobileRequest } = require('../../infrastructure/auth/appSessionRequestAuth');
const { validateContract } = require('../../contracts/generated/passengerTrip');
const {
  getPassengerAppCorsOrigins,
  isAllowedPassengerAppOrigin,
} = require('../../infrastructure/http/passengerAppCors');
const {
  ensureNoActiveAccountDeletion,
  ensureNoActivePassengerAccountDeletion,
} = require('../account-deletion/public');
const { normalizePassengerTripRequest } = require('./passengerTripContract');
const { readPassengerTripSnapshot } = require('./passengerTripSnapshot');

const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');
const { isValidAppSessionId } = loadLegacyLibrary('appSession');
const { parseDateOnly } = loadLegacyLibrary('tourDateIndex');

const endpointOptions = Object.freeze({
  region: 'europe-west1',
  maxInstances: 20,
  timeoutSeconds: 30,
  cors: getPassengerAppCorsOrigins(),
});

/** @param {any} res @param {number} status @param {string} reason */
const sendFailure = (res, status, reason) => res.status(status).json({ success: false, reason });

const sendSnapshotFailure = (res, error) => {
  const code = /** @type {{ code?: string }} */ (error)?.code;
  if (code === 'ACCOUNT_DELETION_IN_PROGRESS') return sendFailure(res, 409, code);
  if (code === 'SESSION_SCOPE_MISMATCH') return sendFailure(res, 403, code);
  if (code === 'TRIP_SOURCE_MISSING') return sendFailure(res, 409, code);
  return sendFailure(res, 503, 'SERVICE_UNAVAILABLE');
};

/** @param {string} reason */
const normalizeSessionFailure = (reason) => {
  if (reason === 'SESSION_CHANGED') return { status: 409, reason: 'SESSION_CHANGED' };
  if (reason === 'SESSION_INACTIVE') return { status: 401, reason: 'SESSION_EXPIRED' };
  return { status: 403, reason: 'SESSION_SCOPE_MISMATCH' };
};

const isValidPassengerTripResponse = (value) => (
  validateContract('PassengerTripSnapshot', value, { clientProjection: true }).valid
  && validateContract('PassengerTripScope', value?.scope, { clientProjection: true }).valid
  && Object.values(value?.parts || {}).every((part) => (
    validateContract('PassengerTripPart', part, { clientProjection: true }).valid
  ))
);

const createPassengerTripSnapshotHandler = ({
  dbFactory = () => admin.database(),
  authorizeRequest = authorizeAppSessionMobileRequest,
  verifySession = verifyActiveAppSession,
  ensureNoAccountDeletion = ensureNoActiveAccountDeletion,
  ensureNoPassengerDeletion = ensureNoActivePassengerAccountDeletion,
  clock = Date.now,
  dateParser = parseDateOnly,
  snapshotReader = readPassengerTripSnapshot,
} = {}) => async (req, res) => {
  if (!isAllowedPassengerAppOrigin(req.headers?.origin)) {
    return sendFailure(res, 403, 'ORIGIN_NOT_ALLOWED');
  }
  if (req.method !== 'POST') return sendFailure(res, 405, 'METHOD_NOT_ALLOWED');
  const request = normalizePassengerTripRequest(req.body);
  if (!request || !isValidAppSessionId(request.expectedSessionId)) {
    return sendFailure(res, 400, 'INVALID_INPUT');
  }
  const requestAuth = await authorizeRequest({ req, res });
  if (!requestAuth) return null;
  const db = dbFactory();
  try {
    const access = await verifySession({
      db,
      authUid: requestAuth.uid,
      expectedRole: 'passenger',
      expectedSessionId: request.expectedSessionId,
    });
    if (!access.allowed) {
      const failure = normalizeSessionFailure(access.reason);
      return sendFailure(res, failure.status, failure.reason);
    }
    const checkedAtMs = clock();
    const response = await snapshotReader({
      db,
      authUid: requestAuth.uid,
      access,
      request,
      nowMs: checkedAtMs,
      parseDateOnly: dateParser,
      ensureNoActiveAccountDeletion: ensureNoAccountDeletion,
      ensureNoActivePassengerAccountDeletion: ensureNoPassengerDeletion,
    });
    const currentAccess = await verifySession({
      db,
      authUid: requestAuth.uid,
      expectedRole: 'passenger',
      expectedSessionId: request.expectedSessionId,
    });
    if (!currentAccess.allowed) {
      const failure = normalizeSessionFailure(currentAccess.reason);
      return sendFailure(res, failure.status, failure.reason);
    }
    if (currentAccess.principalId !== response.scope.principalId
      || currentAccess.tourId !== response.scope.tourId
      || currentAccess.session?.sessionId !== response.scope.sessionId) {
      return sendFailure(res, 403, 'SESSION_SCOPE_MISMATCH');
    }
    if (!isValidPassengerTripResponse(response)) throw new Error('INVALID_PASSENGER_TRIP_RESPONSE');
    res.set('Cache-Control', 'private, no-store, max-age=0');
    return res.status(200).json(response);
  } catch (error) {
    return sendSnapshotFailure(res, error);
  }
};

const createPassengerTripSnapshotFunction = ({ onRequestFn = onRequest, ...dependencies } = {}) => (
  /** @type {any} */ (onRequestFn)(endpointOptions, createPassengerTripSnapshotHandler(dependencies))
);

const getPassengerTripSnapshot = createPassengerTripSnapshotFunction();

module.exports = {
  createPassengerTripSnapshotFunction,
  createPassengerTripSnapshotHandler,
  endpointOptions,
  getPassengerTripSnapshot,
  isValidPassengerTripResponse,
  normalizeSessionFailure,
};
