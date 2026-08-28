'use strict';

// @ts-check

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { log } = require('../../infrastructure/logging/safeLogger');
const { buildPassengerCustomClaims } = require('../passenger-auth/public');
const { processPassengerRoleClaimJobs } = require('./roleTransition');

const onScheduleWithResult = /** @type {any} */ (onSchedule);

const reconcilePassengerRoleClaims = onScheduleWithResult(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Europe/London',
    region: 'europe-west1',
    timeoutSeconds: 120,
  },
  async () => {
    const result = await processPassengerRoleClaimJobs({
      db: admin.database(),
      auth: admin.auth(),
      buildClaims: buildPassengerCustomClaims,
      limit: 50,
    });
    log.info('Passenger role claim reconciliation completed', result);
    return result;
  },
);

module.exports = { reconcilePassengerRoleClaims };
