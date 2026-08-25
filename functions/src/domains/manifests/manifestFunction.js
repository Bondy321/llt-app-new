'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { verifyRequestAuthUid } = require('../../infrastructure/auth/requestAuth');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const { log } = require('../../infrastructure/logging/safeLogger');
const { checkRateLimit, getRequestClientKey, hashRateLimitDimension } = require('../../infrastructure/rate-limit/requestRateLimiter');
const { normalizeTourKeyForComparison, resolveTrimmedString } = require('../notifications/notificationPolicy');
const { buildTourManifestPayload } = require('./manifestDomain');
const { verifyActiveAppSession } = loadLegacyLibrary('appSessionAccess');

const onRequestWithResult = /** @type {any} */ (onRequest);

const getTourManifest = onRequestWithResult(
  {
    region: 'europe-west1',
    maxInstances: 10,
  },
  async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const requestAuth = await verifyRequestAuthUid(req);
    if (!requestAuth.success) {
      return res.status(401).json({ success: false, reason: 'INVALID_CREDENTIALS' });
    }

    const requestedTour = resolveTrimmedString(req.body?.tourId);
    const tourId = normalizeTourKeyForComparison(requestedTour);
    if (!tourId || !isValidFirebaseKey(tourId)) {
      return res.status(400).json({ success: false, reason: 'INVALID_INPUT' });
    }

    const clientKey = getRequestClientKey(req);
    if (!checkRateLimit(`get_tour_manifest_${requestAuth.uid}_${tourId}_${clientKey}`, 30, 60000)) {
      log.warn('Tour manifest rate limit exceeded', {
        authUid: requestAuth.uid,
        tourId,
        networkDimension: hashRateLimitDimension(clientKey),
      });
      return res.status(429).json({ success: false, reason: 'TRY_AGAIN_LATER' });
    }

    try {
      const access = await verifyActiveAppSession({
        db: admin.database(),
        authUid: requestAuth.uid,
        expectedTourId: tourId,
      });
      if (!access.allowed) {
        log.warn('Tour manifest request denied', {
          authUid: requestAuth.uid,
          tourId,
          reason: access.reason,
        });
        return res.status(403).json({ success: false, reason: 'NOT_AUTHORIZED' });
      }

      const manifest = await buildTourManifestPayload({
        tourId,
        requestedTourCode: requestedTour,
      });

      log.info('Tour manifest response built', {
        authUid: requestAuth.uid,
        tourId,
        role: access.role,
        bookingCount: manifest.bookings.length,
      });
      return res.status(200).json({ success: true, ...manifest });
    } catch (error) {
      const errorCode = /** @type {{ code?: string }} */ (error)?.code;
      const reason = errorCode === 'TOUR_NOT_FOUND' ? 'TOUR_NOT_FOUND' : 'INTERNAL_ERROR';
      log.error('Tour manifest request failed', error, {
        authUid: requestAuth.uid,
        tourId,
        reason,
      });
      return res.status(reason === 'TOUR_NOT_FOUND' ? 404 : 500).json({ success: false, reason });
    }
  }
);

module.exports = { getTourManifest };
