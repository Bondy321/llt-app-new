'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { authorizeAppSessionMobileRequest } = require('../../infrastructure/auth/appSessionRequestAuth');
const { parseTrackingStopInput, performDriverTrackingStop } = require('./driverTrackingStop');

const onRequestWithResult = /** @type {any} */ (onRequest);

/** @param {any} [dependencies] */
const createDriverTrackingStopHandler = ({ authorizeRequest = authorizeAppSessionMobileRequest,
  getDatabase = () => admin.database(), stop = performDriverTrackingStop } = {}) =>
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    const requestAuth = await authorizeRequest({ req, res });
    if (!requestAuth) return null;
    const input = parseTrackingStopInput(req.body);
    if (!input) return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    try {
      const result = await stop({ db: getDatabase(), authUid: requestAuth.uid, input });
      return res.status(result.status).json(result.payload);
    } catch {
      return res.status(500).json({ success: false, reason: 'INTERNAL_ERROR' });
    }
  };

const stopDriverTrackingSession = onRequestWithResult(
  { region: 'europe-west1', maxInstances: 20, timeoutSeconds: 30, cors: false },
  createDriverTrackingStopHandler(),
);

module.exports = { createDriverTrackingStopHandler, stopDriverTrackingSession };
