'use strict';

// @ts-check

const { onRequest } = require('firebase-functions/v2/https');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { loadLegacyLibrary } = require('../../bootstrap/legacyLibrary');
const { log } = require('../../infrastructure/logging/safeLogger');
const {
  INGESTION_LIMITS,
  createDriverTourPackPublisher,
} = loadLegacyLibrary('driverTourPackPublisher');
const {
  DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT,
  validateDriverTourPackHttpRequest,
  verifyManagementOidcRequest,
} = loadLegacyLibrary('managementOidc');

const ingestDriverTourPacks = onRequest(
  {
    region: 'europe-west1',
    cors: false,
    invoker: [DEFAULT_MANAGEMENT_SYNC_SERVICE_ACCOUNT],
    memory: '512MiB',
    timeoutSeconds: 120,
    maxInstances: 4,
    concurrency: 4,
  },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');

    const requestGate = validateDriverTourPackHttpRequest(req, {
      maxBodyBytes: INGESTION_LIMITS.maxBodyBytes,
    });
    if (!requestGate.valid) {
      if (requestGate.status === 405) res.set('Allow', 'POST');
      res.status(requestGate.status).json({ ok: false, error: { code: requestGate.code } });
      return;
    }

    try {
      await verifyManagementOidcRequest(req);
      const publisher = createDriverTourPackPublisher({ database: admin.database() });
      const result = await publisher.handle(req.body);
      log.info('Driver Tour Pack ingestion request completed', {
        action: result.action,
        runId: result.runId,
        packCount: result.packCount ?? result.expectedPackCount ?? 0,
        batchIndex: result.batchIndex,
        aggregateFingerprint: result.aggregateFingerprint,
        batchFingerprint: result.batchFingerprint,
        idempotent: result.idempotent,
      });
      res.status(200).json(result);
    } catch (error) {
      const details = /** @type {{ status?: unknown, code?: unknown, message?: unknown }} */ (error || {});
      const status = Number.isInteger(details.status) ? Number(details.status) : 500;
      const code = details.code || 'INGESTION_FAILED';
      log.warn('Driver Tour Pack ingestion request rejected', {
        action: req.body?.action,
        runId: req.body?.runId,
        status,
        code,
      });
      res.status(status).json({
        ok: false,
        error: {
          code,
          message: status >= 500 ? 'Driver Tour Pack ingestion failed.' : String(details.message || code),
        },
      });
    }
  },
);

module.exports = { ingestDriverTourPacks };
