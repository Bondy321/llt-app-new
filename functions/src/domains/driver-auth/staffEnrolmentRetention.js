'use strict';

const { transactExistingRecord } = require('../../infrastructure/database/existingRecordTransaction');
const STAFF_PROOF_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Expired approval evidence has no authority. Keep a bounded thirty-day audit
// window, then remove only the exact observed proof without touching policy or
// installation fences. No raw identifiers or proof digests enter scheduler logs.
const cleanupExpiredStaffEnrolments = async ({ db, nowMs = Date.now(), limit = 100 }) => {
  const pageLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 100));
  const cutoff = nowMs - STAFF_PROOF_RETENTION_MS;
  const page = (await db.ref('driver_enrolments').orderByChild('expiresAtMs')
    .startAt(1).endAt(cutoff).limitToFirst(pageLimit).once('value')).val() || {};
  let removed = 0;
  for (const [hash, observed] of Object.entries(page)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || observed?.schemaVersion !== 1
      || !Number.isSafeInteger(observed.expiresAtMs) || observed.expiresAtMs > cutoff) continue;
    const result = await transactExistingRecord(db.ref(`driver_enrolments/${hash}`), current => (
      JSON.stringify(current) === JSON.stringify(observed) ? null : undefined
    ));
    removed += Number(result.applied);
  }
  return { scanned: Object.keys(page).length, removed, hasMore: Object.keys(page).length === pageLimit };
};

module.exports = { cleanupExpiredStaffEnrolments, STAFF_PROOF_RETENTION_MS };
