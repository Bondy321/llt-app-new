'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { log } = require('../../infrastructure/logging/safeLogger');
const { hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { ensureNoActiveAccountDeletion } = require('../account-deletion/public');
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
      const requestAuth = await verifyRequestAuthUid(req);
      if (requestAuth.success) {
        await ensureNoActiveAccountDeletion({ db: admin.database(), authUid: requestAuth.uid });
      }
      const result = await executePassengerLogin({ req, bookingRef, email });
      return res.status(result.status).json(result.body);
    } catch (error) {
      if (error?.code === 'ACCOUNT_DELETION_IN_PROGRESS') {
        return res.status(409).json({ valid: false, reason: 'ACCOUNT_DELETION_IN_PROGRESS' });
      }
      log.error('Passenger login verification failed', error, {
        bookingRefHash: hashRateLimitDimension(bookingRef),
      });
      return res.status(500).json({ valid: false, reason: 'INTERNAL_ERROR' });
    }
  }
);



module.exports = { verifyPassengerLogin };
