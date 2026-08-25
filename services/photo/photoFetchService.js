const {
  buildPagedPhotoResult,
  databaseRef,
  endAt,
  get,
  limitToLast,
  logPhotoDbEvent,
  mapSnapshotToPhotos,
  normalizeCursor,
  orderByChild,
  query,
  realtimeDbModular,
  sanitizePageLimit,
  summarizePrincipalForDbLog,
} = require('./photoServiceContext');
const {
  resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia,
  sanitizeRealtimeKeySegment,
  validateTourId,
  validateUserId,
} = require('./photoMediaService');

const fetchTourPhotosPage = async (
  { tourId, limit = 30, endBefore = null },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    endAtFn = endAt,
    getFn = get,
    resolveGroupPhotoMediaFn = resolveGroupPhotoMedia,
  } = {},
) => {
  const validatedTourId = validateTourId(tourId);
  const safeLimit = sanitizePageLimit(limit);
  const cursor = normalizeCursor(endBefore);

  const baseRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${validatedTourId}`);
  const constraints = [orderByChildFn('timestamp')];
  if (cursor) {
    constraints.push(endAtFn(cursor.timestamp, cursor.id || undefined));
  }
  constraints.push(limitToLastFn(safeLimit + 1));

  logPhotoDbEvent('debug', 'photo_page_fetch_start', {
    visibility: 'group',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    limit: safeLimit,
    hasCursor: Boolean(cursor),
    cursor: cursor
      ? {
          timestamp: cursor.timestamp,
          id: summarizePrincipalForDbLog(cursor.id),
        }
      : null,
  });
  const snapshot = await getFn(queryFn(baseRef, ...constraints));
  const photos = mapSnapshotToPhotos(snapshot).filter((photo) => {
    if (!cursor) {
      return true;
    }
    return !(photo.timestamp === cursor.timestamp && (!cursor.id || photo.id === cursor.id));
  });

  const result = buildPagedPhotoResult(photos, safeLimit);
  result.items = await resolveGroupPhotoMediaFn({ tourId: validatedTourId, photos: result.items });
  logPhotoDbEvent('debug', 'photo_page_fetch_success', {
    visibility: 'group',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    returnedCount: result.items.length,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
      ? {
          timestamp: result.nextCursor.timestamp,
          id: summarizePrincipalForDbLog(result.nextCursor.id),
        }
      : null,
  });
  return result;
};

/**
 * Fetches a bounded page of private photos for a user ordered by timestamp descending.
 *
 * Input contract:
 * - tourId: required non-empty string
 * - ownerId: required non-empty string
 * - limit: optional positive integer (default 30, max 100)
 * - endBefore: optional cursor ({ timestamp, id }) or timestamp value
 *
 * Output contract:
 * - { items, nextCursor, hasMore }
 * - empty datasets return { items: [], nextCursor: null, hasMore: false }
 * - missing/invalid timestamps are normalized to 0 for deterministic ordering
 *
 * @param {{ tourId: string, ownerId: string, limit?: number, endBefore?: ({ timestamp: unknown, id?: string }|number|string|null) }} params
 * @param {Object} [deps]
 * @returns {Promise<{ items: Array<Object>, nextCursor: ({ timestamp: number, id: string }|null), hasMore: boolean }>}
 */
const fetchPrivatePhotosPage = async (
  { tourId, ownerId, limit = 30, endBefore = null },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    endAtFn = endAt,
    getFn = get,
    resolvePrivatePhotoMediaFn = resolvePrivatePhotoMedia,
  } = {},
) => {
  const validatedTourId = validateTourId(tourId);
  const validatedOwnerId = validateUserId(ownerId);
  const validatedOwnerKey = sanitizeRealtimeKeySegment(validatedOwnerId);
  const safeLimit = sanitizePageLimit(limit);
  const cursor = normalizeCursor(endBefore);

  const baseRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${validatedTourId}/${validatedOwnerKey}`);
  const constraints = [orderByChildFn('timestamp')];
  if (cursor) {
    constraints.push(endAtFn(cursor.timestamp, cursor.id || undefined));
  }
  constraints.push(limitToLastFn(safeLimit + 1));

  logPhotoDbEvent('debug', 'photo_page_fetch_start', {
    visibility: 'private',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    ownerId: summarizePrincipalForDbLog(validatedOwnerId),
    ownerKey: summarizePrincipalForDbLog(validatedOwnerKey),
    limit: safeLimit,
    hasCursor: Boolean(cursor),
    cursor: cursor
      ? {
          timestamp: cursor.timestamp,
          id: summarizePrincipalForDbLog(cursor.id),
        }
      : null,
  });
  const snapshot = await getFn(queryFn(baseRef, ...constraints));
  const photos = mapSnapshotToPhotos(snapshot).filter((photo) => {
    if (!cursor) {
      return true;
    }
    return !(photo.timestamp === cursor.timestamp && (!cursor.id || photo.id === cursor.id));
  });

  const result = buildPagedPhotoResult(photos, safeLimit);
  result.items = await resolvePrivatePhotoMediaFn({
    tourId: validatedTourId,
    ownerKey: validatedOwnerKey,
    photos: result.items,
  });
  logPhotoDbEvent('debug', 'photo_page_fetch_success', {
    visibility: 'private',
    tourId: summarizePrincipalForDbLog(validatedTourId),
    ownerId: summarizePrincipalForDbLog(validatedOwnerId),
    ownerKey: summarizePrincipalForDbLog(validatedOwnerKey),
    returnedCount: result.items.length,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
      ? {
          timestamp: result.nextCursor.timestamp,
          id: summarizePrincipalForDbLog(result.nextCursor.id),
        }
      : null,
  });
  return result;
};

// ==================== VALIDATION HELPERS ====================

module.exports = { fetchPrivatePhotosPage, fetchTourPhotosPage };

/**
 * Validates tour ID
 */
