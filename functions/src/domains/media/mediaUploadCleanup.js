'use strict';

const { transactExistingRecord } = require('../../infrastructure/database/existingRecordTransaction');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { admin } = require('../../bootstrap/firebaseAdmin');
const { log } = require('../../infrastructure/logging/safeLogger');
const { mediaOperationPaths } = require('./mediaPublication');

// A retained empty object is a storage tombstone: delayed ifGenerationMatch:0
// uploads can never recreate customer bytes after cleanup has completed.
const installCancellationSentinel = async ({ bucket, operation }) => {
  const file = bucket.file(operation.storagePath);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let metadata = null;
    try { [metadata] = await file.getMetadata(); }
    catch (error) { if (Number(error.code) !== 404) throw error; }
    if (metadata && (metadata.metadata?.uploadOperationId !== operation.operationId
      || metadata.metadata?.authUid !== operation.authUid)) throw new Error('Media object ownership changed');
    if (metadata?.metadata?.cancelled === 'true' && Number(metadata.size) === 0) return;
    try {
      await file.save(Buffer.alloc(0), { resumable: false,
        preconditionOpts: { ifGenerationMatch: metadata?.generation || 0 },
        metadata: { contentType: 'application/octet-stream', cacheControl: 'private,no-store',
          metadata: { uploadOperationId: operation.operationId, authUid: operation.authUid,
            cancelled: 'true', sourceRole: 'cancelled' } } });
      return;
    } catch (error) { if (Number(error.code) !== 412 || attempt === 3) throw error; }
  }
};

const cleanupMediaUploadOperation = async ({ db, bucket, authUid, operationId, nowMs = Date.now() }) => {
  const opRef = db.ref(`media_upload_operations/${authUid}/${operationId}`);
  const initial = (await opRef.once('value')).val();
  if (!initial) throw new Error('Media cleanup operation missing');
  if (initial.state === 'committed') {
    await db.ref(`media_upload_cleanup_queue/${operationId}`).remove();
    return 'committed';
  }
  if (initial.expiresAtMs > nowMs) return 'waiting';
  const claim = await transactExistingRecord(opRef, current => {
    if (!current || current.state === 'committed' || current.expiresAtMs > nowMs) return undefined;
    return { ...current, state: 'cancelled' };
  });
  if (!claim.applied) return 'changed';
  const operation = claim.snapshot.val();
  await installCancellationSentinel({ bucket, operation });
  const { recordPath } = mediaOperationPaths(operation);
  await db.ref(recordPath).transaction(current => {
    if (!current) return current;
    if (current._upload?.operationId !== operationId || current._upload?.authUid !== authUid
      || current._upload?.status === 'complete') return undefined;
    return null;
  }, undefined, false);
  const remaining = (await db.ref(recordPath).once('value')).val();
  if (remaining?._upload?.operationId === operationId) throw new Error('Media cleanup metadata changed');
  const finished = await transactExistingRecord(opRef, current => current?.state === 'cancelled'
    ? { ...current, state: 'cleaned', cleanedAtMs: nowMs } : undefined);
  if (!finished.applied || finished.snapshot.val()?.state !== 'cleaned') throw new Error('Media cleanup acknowledgement changed');
  await db.ref(`media_upload_cleanup_queue/${operationId}`).remove();
  return 'cleaned';
};

const runMediaUploadCleanup = async ({ db, bucket, nowMs = Date.now(), limit = 25 }) => {
  const due = await db.ref('media_upload_cleanup_queue').orderByChild('dueAtMs')
    .endAt(nowMs).limitToFirst(Math.min(25, Math.max(1, limit))).once('value');
  const result = { inspected: 0, cleaned: 0, deferred: 0, oldestDueAgeMs: 0 };
  for (const entry of Object.values(due.val() || {})) {
    if (Number.isFinite(entry.dueAtMs)) result.oldestDueAgeMs = Math.max(result.oldestDueAgeMs, nowMs - entry.dueAtMs);
  }
  for (const [operationId, entry] of Object.entries(due.val() || {})) {
    result.inspected += 1;
    try {
      const state = await cleanupMediaUploadOperation({ db, bucket, authUid: entry.authUid, operationId, nowMs });
      if (state === 'cleaned') result.cleaned += 1;
    } catch {
      result.deferred += 1;
      // Bound retries and prevent one broken object starving the due queue.
      await db.ref(`media_upload_cleanup_queue/${operationId}/dueAtMs`).set(nowMs + 5 * 60 * 1000);
    }
  }
  return result;
};

const cleanupPendingMediaUploads = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/London', region: 'europe-west1',
  timeoutSeconds: 300, maxInstances: 1, concurrency: 1 },
async () => {
  const summary = await runMediaUploadCleanup({ db: admin.database(), bucket: admin.storage().bucket() });
  log.info('Media upload cleanup health', summary);
  return summary;
});

module.exports = { installCancellationSentinel, cleanupMediaUploadOperation, runMediaUploadCleanup, cleanupPendingMediaUploads };
