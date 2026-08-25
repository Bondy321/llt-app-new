'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { log } = require('../../infrastructure/logging/safeLogger');
const { normalizeBookingRef, normalizeEmail } = require('./passengerSanitizer');
const { executePassengerLogin } = require('./passengerLoginWorkflow');

const onRequestWithResult = /** @type {any} */ (onRequest);

const verifyPassengerLogin = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const bookingRef = normalizeBookingRef(req.body?.bookingRef);
    const email = normalizeEmail(req.body?.email);

    if (!bookingRef || !email) {
      return res.status(400).json({ valid: false, reason: 'INVALID_INPUT' });
    }

    try {
      const result = await executePassengerLogin({ req, bookingRef, email });
      return res.status(result.status).json(result.body);
    } catch (error) {
      log.error('Passenger login verification failed', error, { bookingRef });
      return res.status(500).json({ valid: false, reason: 'INTERNAL_ERROR' });
    }
  }
);



module.exports = { verifyPassengerLogin };
