'use strict';
const { createHash } = require('node:crypto');
const snapshotIdentity = record => createHash('sha256').update(JSON.stringify([
  record?.userId, record?.idempotencyKey, record?.storagePath, record?.viewerStoragePath, record?.thumbnailStoragePath,
  record?.variantVersion, record?.variantUpdatedAt, record?.contentHash, record?.timestamp, record?._upload?.operationId,
])).digest('hex');
const isReadableMediaRecord = record => Boolean(record && !record._serverDeletion && (!record._upload || record._upload.status === 'complete'));
const sameMediaAuthority = (before, after) => Boolean(after?.allowed && before?.allowed
  && before.principalId === after.principalId && before.role === after.role
  && (before.session?.sessionId || null) === (after.session?.sessionId || null)
  && (before.session?.sessionRevision || null) === (after.session?.sessionRevision || null));

// Drop URLs generated while the exact session, owner or record was withdrawn.
// Previously delivered short-lived URLs remain valid until expiry; they are not
// a revocable transport and must never be represented as immediately revoked.
async function signCurrentMedia({ access, readAccess, readRecords, sign, records }) {
  const readable = Object.fromEntries(Object.entries(records).filter(([, record]) => isReadableMediaRecord(record)));
  const media = await sign(readable);
  const currentRecords = await readRecords();
  const currentAccess = await readAccess();
  if (!sameMediaAuthority(access, currentAccess)) return { allowed: false, media: {} };
  return { allowed: true, media: Object.fromEntries(Object.entries(media).filter(([id]) => isReadableMediaRecord(currentRecords[id])
    && snapshotIdentity(readable[id]) === snapshotIdentity(currentRecords[id]))) };
}
module.exports = { signCurrentMedia, sameMediaAuthority, isReadableMediaRecord };
