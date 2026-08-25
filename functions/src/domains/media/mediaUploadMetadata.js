'use strict';

// @ts-check

const { isValidFirebaseKey } = require('../../infrastructure/database/firebaseKey');
const {
  normalizeTourKeyForComparison,
  resolveTrimmedString,
  toRealtimeKeySegment,
} = require('../notifications/notificationPolicy');

/** @param {unknown} rawHeader */
const normalizeGroupPhotoUploadMetadata = (rawHeader) => {
  if (typeof rawHeader !== 'string' || rawHeader.length > 4096) return null;
  try {
    const input = JSON.parse(decodeURIComponent(rawHeader));
    const tourId = normalizeTourKeyForComparison(input.tourId);
    const idempotencyKey = resolveTrimmedString(input.idempotencyKey);
    const caption = resolveTrimmedString(input.caption) || '';
    const uploaderName = resolveTrimmedString(input.uploaderName) || 'Tour Member';
    if (!tourId || !isValidFirebaseKey(tourId) || !idempotencyKey || idempotencyKey.length > 180
      || !isValidFirebaseKey(toRealtimeKeySegment(idempotencyKey)) || caption.length > 500
      || uploaderName.length > 100) return null;
    return { tourId, idempotencyKey, caption, uploaderName };
  } catch (_error) {
    return null;
  }
};

/** @param {unknown} contentType */
const extensionForGroupPhotoContentType = (contentType) => ({
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
})[String(contentType)] || null;

module.exports = { extensionForGroupPhotoContentType, normalizeGroupPhotoUploadMetadata };
