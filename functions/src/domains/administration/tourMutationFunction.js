'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { authorizeAdminMutation } = require('./administrationFunctions');
const { applyTourMutation } = require('./tourMutation');
const { log } = require('../../infrastructure/logging/safeLogger');

const mutateTour = onRequest({ region: 'europe-west1', maxInstances: 5, timeoutSeconds: 60 }, async (req, res) => {
  const access = await authorizeAdminMutation({ req, res });
  if (!access.allowed) return access.response;
  try {
    const result = await applyTourMutation({ db: access.db, tourId: req.body?.tourId, mode: req.body?.mode,
      values: req.body?.values, expectedRevision: req.body?.expectedRevision });
    log.info('Admin tour mutation committed', { tourId: result.id, mode: req.body.mode, authUid: access.authUid, revision: result.revision });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const reason = error?.code || 'INTERNAL_ERROR';
    const status = reason.startsWith('INVALID_') ? 400 : reason.startsWith('TOUR_') ? 409 : 500;
    if (status === 500) log.error('Admin tour mutation failed', error);
    return res.status(status).json({ success: false, reason: status === 500 ? 'INTERNAL_ERROR' : reason });
  }
});
module.exports = { mutateTour };
