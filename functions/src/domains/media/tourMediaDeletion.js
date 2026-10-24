'use strict';

const { cleanupMediaUploadOperation } = require('./mediaUploadCleanup');
const { deleteOwnedGroupPhotoRecord } = require('./groupMediaFunctions');
const { deleteOwnedPrivatePhotoRecord } = require('./privateMediaFunctions');
const { readBoundedShallowKeys } = require('../../infrastructure/database/shallowKeys');
const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const pending = () => Object.assign(new Error('Tour media cleanup must continue'), { code: 'STORAGE_CLEANUP_PENDING' });

// The tour lifecycle is already deleting and its source lease remains held.
// No new reserve may commit. Drain existing reservations before the final
// prefix sweep, preserving their permanent cancellation objects.
const drainTourMediaForDeletion = async ({ db, bucket, tourId, beforeRecord = async () => {}, maxRecords = 50, nowMs = Date.now() }) => {
  if (!isValidFirebaseKey(tourId)) throw new Error('Invalid tour media scope');
  let processed = 0;
  const drain = async ({ visibility, ownerKey, photoId, record }) => {
    if (processed >= maxRecords) throw pending();
    await beforeRecord();
    const path = visibility === 'group' ? `group_tour_photos/${tourId}/${photoId}`
      : `private_tour_photos/${tourId}/${ownerKey}/${photoId}`;
    if (record?._upload && record._upload.status !== 'complete') {
      const { authUid, operationId } = record._upload;
      if (![authUid, operationId].every(isValidFirebaseKey)) throw pending();
      const state = await cleanupMediaUploadOperation({ db, bucket, authUid, operationId, nowMs });
      if (state !== 'cleaned') throw pending();
      record = (await db.ref(path).once('value')).val();
      if (!record) { processed += 1; return; }
    }
    if (!isValidFirebaseKey(record?.userId)) throw new Error('Tour media owner is invalid');
    const options = { db, bucket, tourId, photoId, trustedOwnerKeys: [record.userId], assertCanDelete: beforeRecord };
    const result = visibility === 'group' ? await deleteOwnedGroupPhotoRecord(options)
      : await deleteOwnedPrivatePhotoRecord({ ...options, ownerKey });
    if (!result.deleted && !result.alreadyDeleted) throw new Error('Tour media ownership changed');
    processed += 1;
  };
  const group = (await db.ref(`group_tour_photos/${tourId}`).orderByKey().limitToFirst(maxRecords + 1).once('value')).val() || {};
  for (const [photoId, record] of Object.entries(group)) await drain({ visibility: 'group', photoId, record });
  const owners = await readBoundedShallowKeys({ db, path: `private_tour_photos/${tourId}` });
  for (const ownerKey of owners) {
    const records = (await db.ref(`private_tour_photos/${tourId}/${ownerKey}`).orderByKey().limitToFirst(maxRecords + 1).once('value')).val() || {};
    for (const [photoId, record] of Object.entries(records)) await drain({ visibility: 'private', ownerKey, photoId, record });
  }
  return { processed };
};

module.exports = { drainTourMediaForDeletion };
