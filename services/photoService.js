// services/photoService.js
// Production-ready photo service using server-mediated Storage and Realtime Database metadata
// Enhanced with comprehensive validation, file type checking, and size limits

const {
  ref: databaseRef,
  remove,
  serverTimestamp,
  onValue,
  get,
  update,
  query,
  orderByChild,
  limitToLast,
  endAt,
} = require('firebase/database');
const { realtimeDbModular, auth, getCurrentAppCheckToken } = require('../firebase');
const { normalizePhotoUri } = require('./photoVariantService');
const { loadOptionalService } = require('./optionalServiceLoader');
const { assertTextPassesModeration } = require('./contentModerationService');

const loggerServiceModule = loadOptionalService({
  modulePath: './loggerService',
  loadModule: () => require('./loggerService'),
  serviceLabel: 'Logger service',
});
const logger = loggerServiceModule?.default || loggerServiceModule;

// ==================== CONSTANTS ====================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
const MAX_CAPTION_LENGTH = 500;
const LIVE_PHOTOS_WINDOW = 100;
const PHOTO_CACHE_CONTROL_HEADER = 'private,max-age=300,no-transform';
const IDEMPOTENCY_KEY_MAX_LENGTH = 180;
const PRIVATE_MEDIA_BATCH_LIMIT = 50;
const PRIVATE_MEDIA_FUNCTION_NAME = 'resolvePrivatePhotoMedia';
const PRIVATE_UPLOAD_FUNCTION_NAME = 'uploadPrivatePhoto';
const PRIVATE_DELETE_FUNCTION_NAME = 'deletePrivatePhoto';
const GROUP_MEDIA_FUNCTION_NAME = 'resolveGroupPhotoMedia';
const GROUP_UPLOAD_FUNCTION_NAME = 'uploadGroupPhoto';
const GROUP_DELETE_FUNCTION_NAME = 'deleteGroupPhoto';

const summarizeUriForDbLog = (uri) => {
  if (typeof uri !== 'string' || !uri.trim()) {
    return { present: false };
  }

  const normalized = uri.trim();
  const schemeMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return {
    present: true,
    scheme: schemeMatch?.[1]?.toLowerCase() || 'unknown',
    totalLength: normalized.length,
  };
};

const summarizeErrorForDbLog = (error) => ({
  name: error?.name || 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
  message: error?.message || String(error),
});

const logPhotoDbEvent = (level, eventName, payload = {}) => {
  try {
    const persistLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    if (logger && typeof logger[persistLevel] === 'function') {
      logger[persistLevel]('PhotoService', eventName, payload);
    }
  } catch (error) {
    // Realtime database diagnostics must never affect photo behavior.
  }
};

const stableHash = (value) => {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const summarizePathForDbLog = (path) => {
  if (typeof path !== 'string' || !path.trim()) {
    return { present: false };
  }

  const normalized = path.trim();
  return {
    present: true,
    length: normalized.length,
    segmentCount: normalized.split('/').filter(Boolean).length,
    hash: stableHash(normalized),
    containsEncodedDot: normalized.includes('_2E_'),
  };
};

const summarizePrincipalForDbLog = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    return { present: false };
  }

  const normalized = value.trim();
  return {
    present: true,
    length: normalized.length,
    hash: stableHash(normalized),
    isRealtimeSafe: !/[.#$\/\[\]\x00-\x1F\x7F]/.test(normalized),
    containsEmailSeparator: normalized.includes('@') || normalized.includes('_40_'),
  };
};

const sanitizeStorageSegment = (value, fallback = 'photo') => {
  if (typeof value !== 'string') return fallback;
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
  return sanitized || fallback;
};

const resolveRealtimeTimestamp = (serverTimestampFn, nowFn = Date.now) => {
  try {
    const candidate = typeof serverTimestampFn === 'function' ? serverTimestampFn() : null;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  } catch (error) {
    // Fall back to a client timestamp when the SDK placeholder cannot be serialized as a number.
  }

  const fallback = nowFn();
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : Date.now();
};

// ==================== PAGINATION HELPERS ====================

/**
 * Normalizes mixed timestamp values into a safe numeric millisecond value.
 * Supports numbers, numeric strings, Date instances, and known timestamp-like objects.
 * Missing/unsupported values are normalized to 0 so ordering remains deterministic.
 * @param {unknown} rawTimestamp
 * @returns {number}
 */
const normalizeTimestamp = (rawTimestamp) => {
  if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
    return rawTimestamp;
  }

  if (typeof rawTimestamp === 'string') {
    const asNumber = Number(rawTimestamp);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
  }

  if (rawTimestamp instanceof Date && Number.isFinite(rawTimestamp.getTime())) {
    return rawTimestamp.getTime();
  }

  if (rawTimestamp && typeof rawTimestamp === 'object') {
    if (typeof rawTimestamp.toMillis === 'function') {
      const millis = rawTimestamp.toMillis();
      if (Number.isFinite(millis)) {
        return millis;
      }
    }

    if (typeof rawTimestamp.seconds === 'number') {
      const millis = rawTimestamp.seconds * 1000;
      if (Number.isFinite(millis)) {
        return millis;
      }
    }

    if (typeof rawTimestamp._seconds === 'number') {
      const millis = rawTimestamp._seconds * 1000;
      if (Number.isFinite(millis)) {
        return millis;
      }
    }

    if (typeof rawTimestamp.timestamp === 'number') {
      return rawTimestamp.timestamp;
    }
  }

  return 0;
};

const sanitizePageLimit = (limit) => {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30;
  }
  return Math.min(parsed, 100);
};

const normalizeCursor = (endBefore) => {
  if (endBefore == null) {
    return null;
  }

  if (typeof endBefore === 'number' || typeof endBefore === 'string') {
    const timestamp = normalizeTimestamp(endBefore);
    if (timestamp <= 0) {
      return null;
    }
    return { timestamp, id: null };
  }

  if (typeof endBefore === 'object') {
    const timestamp = normalizeTimestamp(endBefore.timestamp);
    if (timestamp <= 0) {
      return null;
    }
    const id = typeof endBefore.id === 'string' && endBefore.id.length > 0 ? endBefore.id : null;
    return { timestamp, id };
  }

  return null;
};

const normalizeOptionalString = (value) => {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeOptionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizePhotoRecordForClient = (id, value, extras = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const photo = {
    ...source,
    ...extras,
    id,
    timestamp: normalizeTimestamp(source?.timestamp),
  };

  ['sourceUrl', 'thumbnailUrl', 'viewerUrl'].forEach((field) => {
    const uri = normalizePhotoUri(source?.[field]);
    if (uri) {
      photo[field] = uri;
    } else {
      delete photo[field];
    }
  });

  [
    'userId',
    'caption',
    'uploaderName',
    'storagePath',
    'thumbnailStoragePath',
    'viewerStoragePath',
    'fileType',
    'idempotencyKey',
    'variantStatus',
    'variantError',
    'captionEditedBy',
  ].forEach((field) => {
    const normalized = normalizeOptionalString(source?.[field]);
    if (normalized) {
      photo[field] = normalized;
    } else {
      delete photo[field];
    }
  });

  ['fileSize', 'variantUpdatedAt', 'variantVersion', 'captionUpdatedAt'].forEach((field) => {
    const normalized = normalizeOptionalNumber(source?.[field]);
    if (normalized !== null) {
      photo[field] = normalized;
    } else {
      delete photo[field];
    }
  });

  return photo;
};

const mapSnapshotToPhotos = (snapshot, extras = {}) => {
  const data = snapshot.val() || {};
  return Object.entries(data).map(([id, value]) => normalizePhotoRecordForClient(id, value, extras));
};

const sortPhotosDescending = (photos) => {
  photos.sort((a, b) => {
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }

    return b.id.localeCompare(a.id);
  });
};

const buildPagedPhotoResult = (photos, limit) => {
  sortPhotosDescending(photos);

  const hasMore = photos.length > limit;
  const items = hasMore ? photos.slice(0, limit) : photos;
  const lastItem = items[items.length - 1] || null;

  return {
    items,
    nextCursor: lastItem ? { timestamp: lastItem.timestamp, id: lastItem.id } : null,
    hasMore,
  };
};

/**
 * Fetches a bounded page of group tour photos ordered by timestamp descending.
 *
 * Input contract:
 * - tourId: required non-empty string
 * - limit: optional positive integer (default 30, max 100)
 * - endBefore: optional cursor ({ timestamp, id }) or timestamp value
 *
 * Output contract:
 * - { items, nextCursor, hasMore }
 * - empty datasets return { items: [], nextCursor: null, hasMore: false }
 * - missing/invalid timestamps are normalized to 0 for deterministic ordering
 *
 * @param {{ tourId: string, limit?: number, endBefore?: ({ timestamp: unknown, id?: string }|number|string|null) }} params
 * @param {Object} [deps]
 * @returns {Promise<{ items: Array<Object>, nextCursor: ({ timestamp: number, id: string }|null), hasMore: boolean }>}
 */
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

/**
 * Validates tour ID
 */
const validateTourId = (tourId) => {
  if (!tourId || typeof tourId !== 'string' || tourId.trim().length === 0) {
    throw new Error('Invalid tour ID');
  }
  return tourId.trim();
};

/**
 * Validates user ID
 */
const validateUserId = (userId) => {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Invalid user ID');
  }
  return userId.trim();
};

const sanitizeRealtimeKeySegment = (value) => (
  value.replace(/[.#$/\[\]\x00-\x1F\x7F]/g, (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}_`)
);

/**
 * Validates photo ID
 */
const validatePhotoId = (photoId) => {
  if (!photoId || typeof photoId !== 'string' || photoId.trim().length === 0) {
    throw new Error('Invalid photo ID');
  }
  return photoId.trim();
};

/**
 * Validates file URI
 */
const validateUri = (uri) => {
  if (!uri || typeof uri !== 'string' || uri.trim().length === 0) {
    throw new Error('Invalid file URI');
  }
  return uri.trim();
};

/**
 * Validates visibility setting
 */
const validateVisibility = (visibility) => {
  if (visibility && visibility !== 'group' && visibility !== 'private') {
    throw new Error('Visibility must be either "group" or "private"');
  }
  return visibility || 'group';
};

/**
 * Validates caption
 */
const validateCaption = (caption) => {
  if (caption && typeof caption !== 'string') {
    throw new Error('Caption must be a string');
  }

  const trimmed = (caption || '').trim();
  if (trimmed.length > MAX_CAPTION_LENGTH) {
    throw new Error(`Caption exceeds maximum length of ${MAX_CAPTION_LENGTH} characters`);
  }

  return assertTextPassesModeration(trimmed, 'Caption');
};

const buildPrivateMediaEndpointUrl = (authInstance = auth) => {
  const explicit = process.env.EXPO_PUBLIC_RESOLVE_PRIVATE_PHOTO_MEDIA_URL?.trim();
  if (explicit) return explicit;
  const projectId = authInstance?.app?.options?.projectId;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${PRIVATE_MEDIA_FUNCTION_NAME}` : null;
};

const buildPrivatePhotoEndpointUrl = (functionName, authInstance = auth) => {
  const envNames = {
    [PRIVATE_UPLOAD_FUNCTION_NAME]: 'EXPO_PUBLIC_UPLOAD_PRIVATE_PHOTO_URL',
    [PRIVATE_DELETE_FUNCTION_NAME]: 'EXPO_PUBLIC_DELETE_PRIVATE_PHOTO_URL',
  };
  const explicit = process.env[envNames[functionName]]?.trim();
  if (explicit) return explicit;
  const projectId = authInstance?.app?.options?.projectId;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}` : null;
};

const buildGroupPhotoEndpointUrl = (functionName, authInstance = auth) => {
  const envNames = {
    [GROUP_MEDIA_FUNCTION_NAME]: 'EXPO_PUBLIC_RESOLVE_GROUP_PHOTO_MEDIA_URL',
    [GROUP_UPLOAD_FUNCTION_NAME]: 'EXPO_PUBLIC_UPLOAD_GROUP_PHOTO_URL',
    [GROUP_DELETE_FUNCTION_NAME]: 'EXPO_PUBLIC_DELETE_GROUP_PHOTO_URL',
  };
  const explicit = process.env[envNames[functionName]]?.trim();
  if (explicit) return explicit;
  const projectId = authInstance?.app?.options?.projectId;
  return projectId ? `https://europe-west1-${projectId}.cloudfunctions.net/${functionName}` : null;
};

const buildGroupPhotoAuthHeaders = async (authInstance = auth, appCheckTokenFn = getCurrentAppCheckToken) => {
  const token = await authInstance?.currentUser?.getIdToken?.();
  if (!token) throw new Error('Authenticated user required for group photos');
  const appCheckToken = await appCheckTokenFn?.();
  if (!appCheckToken) throw new Error('App verification required for group photos');
  return { Authorization: `Bearer ${token}`, 'x-firebase-appcheck': appCheckToken };
};

const resolveGroupPhotoMedia = async ({ tourId, photos }, {
  authInstance = auth,
  fetchFn = fetch,
  endpoint = buildGroupPhotoEndpointUrl(GROUP_MEDIA_FUNCTION_NAME, authInstance),
  appCheckTokenFn = getCurrentAppCheckToken,
} = {}) => {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const safePhotos = photos.map((photo) => {
    const { sourceUrl: _sourceUrl, viewerUrl: _viewerUrl, thumbnailUrl: _thumbnailUrl, ...safePhoto } = photo;
    return safePhoto;
  });
  if (!endpoint) return safePhotos;
  const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
  const resolvedMedia = {};
  for (let offset = 0; offset < safePhotos.length; offset += PRIVATE_MEDIA_BATCH_LIMIT) {
    const batch = safePhotos.slice(offset, offset + PRIVATE_MEDIA_BATCH_LIMIT);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId, photoIds: batch.map((photo) => photo.id) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true || !payload.media || typeof payload.media !== 'object'
      || Array.isArray(payload.media) || Number(payload.expiresAtMs) <= Date.now()) {
      throw new Error('Group photo access could not be authorized');
    }
    Object.assign(resolvedMedia, payload.media);
  }
  return safePhotos.map((photo) => ({ ...photo, ...(resolvedMedia[photo.id] || {}) }));
};

const resolvePrivatePhotoMedia = async ({ tourId, ownerKey, photos }, {
  authInstance = auth,
  fetchFn = fetch,
  endpoint = buildPrivateMediaEndpointUrl(authInstance),
  appCheckTokenFn = getCurrentAppCheckToken,
} = {}) => {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const safePhotos = photos.map((photo) => {
    const { sourceUrl: _sourceUrl, viewerUrl: _viewerUrl, thumbnailUrl: _thumbnailUrl, ...safePhoto } = photo;
    return safePhoto;
  });
  if (!endpoint) return safePhotos;
  const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
  const resolvedMedia = {};
  for (let offset = 0; offset < safePhotos.length; offset += PRIVATE_MEDIA_BATCH_LIMIT) {
    const batch = safePhotos.slice(offset, offset + PRIVATE_MEDIA_BATCH_LIMIT);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId, ownerKey, photoIds: batch.map((photo) => photo.id) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true || !payload.media || typeof payload.media !== 'object'
      || Array.isArray(payload.media)
      || (payload.expiresAtMs != null && Number(payload.expiresAtMs) <= Date.now())) {
      throw new Error('Private photo access could not be authorized');
    }
    Object.assign(resolvedMedia, payload.media);
  }
  return safePhotos.map((photo) => ({ ...photo, ...(resolvedMedia[photo.id] || {}) }));
};

/**
 * Validates blob and checks file type and size
 */
const validateBlob = (blob) => {
  if (!blob) {
    throw new Error('Invalid file blob');
  }

  // Check file size
  if (blob.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds maximum of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  // Check file type
  if (!ALLOWED_IMAGE_TYPES.includes(blob.type)) {
    throw new Error(`File type ${blob.type} is not supported. Allowed types: ${ALLOWED_IMAGE_TYPES.join(', ')}`);
  }

  return blob;
};

// ==================== BLOB HANDLING ====================

const createBlob = async (uri, fetchFn = fetch) => {
  const response = await fetchFn(uri);

  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }

  const blob = await response.blob();
  return blob;
};

const uploadPhoto = async (
  uri,
  tourId,
  userId,
  caption = '',
  {
    visibility = 'group',
    uploaderName = 'Tour Member',
    authInstance = auth,
    fetchFn = fetch,
    onProgress = null,
    optimizationMetrics = null,
    idempotencyKey = null,
    nowFn = Date.now,
    groupUploadEndpoint = buildGroupPhotoEndpointUrl(GROUP_UPLOAD_FUNCTION_NAME, authInstance),
    privateUploadEndpoint = buildPrivatePhotoEndpointUrl(PRIVATE_UPLOAD_FUNCTION_NAME, authInstance),
    appCheckTokenFn = getCurrentAppCheckToken,
  } = {}
) => {
  let uploadStage = 'initializing';
  let uploadDiagnostics = {};

  try {
    // Validate inputs
    uploadStage = 'validating_inputs';
    const validatedUri = validateUri(uri);
    const validatedTourId = validateTourId(tourId);
    const validatedUserId = validateUserId(userId);
    const validatedUserKey = sanitizeRealtimeKeySegment(validatedUserId);
    const validatedCaption = validateCaption(caption);
    const validatedVisibility = validateVisibility(visibility);
    const normalizedIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim()
      ? idempotencyKey.trim().slice(0, IDEMPOTENCY_KEY_MAX_LENGTH)
      : null;

    const authUid = typeof authInstance?.currentUser?.uid === 'string' && authInstance.currentUser.uid.trim()
      ? authInstance.currentUser.uid.trim()
      : null;
    if (!authUid) {
      throw new Error('Authenticated user required for photo upload');
    }

    const isPrivate = validatedVisibility === 'private';
    uploadDiagnostics = {
      visibility: validatedVisibility,
      tourId: summarizePrincipalForDbLog(validatedTourId),
      userId: summarizePrincipalForDbLog(validatedUserId),
      ownerKey: summarizePrincipalForDbLog(validatedUserKey),
      ownerKeyMatchesUserId: validatedUserKey === validatedUserId,
      hasIdempotencyKey: Boolean(normalizedIdempotencyKey),
      idempotencyKey: summarizePrincipalForDbLog(normalizedIdempotencyKey),
      uri: summarizeUriForDbLog(validatedUri),
    };
    logPhotoDbEvent('info', 'photo_upload_start', uploadDiagnostics);

    // Create blob and validate
    uploadStage = 'fetching_source_blob';
    const blob = await createBlob(validatedUri, fetchFn);
    uploadStage = 'validating_source_blob';
    validateBlob(blob);
    uploadDiagnostics = {
      ...uploadDiagnostics,
      fileType: blob.type || null,
      fileSize: typeof blob.size === 'number' ? blob.size : null,
    };

    if (!isPrivate) {
      uploadStage = 'uploading_group_photo_via_server';
      try {
        if (!normalizedIdempotencyKey) throw new Error('idempotencyKey is required for group photo uploads');
        if (!groupUploadEndpoint) throw new Error('Group photo upload endpoint is unavailable');
        const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
        if (typeof onProgress === 'function') onProgress(0.05);
        const encodedMetadata = encodeURIComponent(JSON.stringify({
          tourId: validatedTourId,
          idempotencyKey: normalizedIdempotencyKey,
          caption: validatedCaption,
          uploaderName: uploaderName || 'Tour Member',
        }));
        const response = await fetchFn(groupUploadEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': blob.type,
            'x-group-photo-metadata': encodedMetadata,
            ...authHeaders,
          },
          body: blob,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success !== true || !payload.photo?.id) {
          throw new Error(payload?.reason === 'NOT_AUTHORIZED'
            ? 'You no longer have access to this tour'
            : 'Group photo upload could not be authorized');
        }
        if (typeof onProgress === 'function') onProgress(1);
        return payload.photo;
      } finally {
        if (blob && typeof blob.close === 'function') {
          try { blob.close(); } catch (error) { /* best-effort release */ }
        }
      }
    }

    uploadStage = 'uploading_private_photo_via_server';
    try {
      if (!normalizedIdempotencyKey) throw new Error('idempotencyKey is required for private photo uploads');
      if (!privateUploadEndpoint) throw new Error('Private photo upload endpoint is unavailable');
      const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
      if (typeof onProgress === 'function') onProgress(0.05);
      const encodedMetadata = encodeURIComponent(JSON.stringify({
        tourId: validatedTourId,
        idempotencyKey: normalizedIdempotencyKey,
        caption: validatedCaption,
      }));
      const response = await fetchFn(privateUploadEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type,
          'x-private-photo-metadata': encodedMetadata,
          ...authHeaders,
        },
        body: blob,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true || !payload.photo?.id) {
        throw new Error(payload?.reason === 'NOT_AUTHORIZED'
          ? 'You no longer have access to this tour'
          : 'Private photo upload could not be authorized');
      }
      if (typeof onProgress === 'function') onProgress(1);
      return payload.photo;
    } finally {
      if (blob && typeof blob.close === 'function') {
        try { blob.close(); } catch (error) { /* best-effort release */ }
      }
    }
  } catch (error) {
    logPhotoDbEvent('error', 'photo_upload_failed', {
      stage: uploadStage,
      diagnostics: uploadDiagnostics,
      tourId: summarizePrincipalForDbLog(typeof tourId === 'string' ? tourId.trim() : null),
      userId: summarizePrincipalForDbLog(typeof userId === 'string' ? userId.trim() : null),
      visibility,
      captionLength: typeof caption === 'string' ? caption.trim().length : 0,
      uri: summarizeUriForDbLog(uri),
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};

const subscribeToTourPhotos = (
  tourId,
  callback,
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    onValueFn = onValue,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    limit = LIVE_PHOTOS_WINDOW,
    resolveGroupPhotoMediaFn = resolveGroupPhotoMedia,
  } = {}
) => {
  try {
    // Validate inputs
    const validatedTourId = validateTourId(tourId);

    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }

    if (!realtimeDbInstance) {
      logPhotoDbEvent('warn', 'photo_subscription_db_unavailable', {
        visibility: 'group',
        tourId: summarizePrincipalForDbLog(validatedTourId),
      });
      return () => {};
    }

    const photosRef = dbRefFn(realtimeDbInstance, `group_tour_photos/${validatedTourId}`);
    const liveLimit = sanitizePageLimit(limit || LIVE_PHOTOS_WINDOW);
    const photosQuery = queryFn(photosRef, orderByChildFn('timestamp'), limitToLastFn(liveLimit));

    logPhotoDbEvent('debug', 'photo_subscription_start', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(validatedTourId),
      liveLimit,
    });
    let generation = 0;
    const unsubscribe = onValueFn(photosQuery, (snapshot) => {
      const currentGeneration = ++generation;
      try {
        let photos = mapSnapshotToPhotos(snapshot);
        sortPhotosDescending(photos);
        const safePhotos = photos.map((photo) => {
          const { sourceUrl: _sourceUrl, viewerUrl: _viewerUrl, thumbnailUrl: _thumbnailUrl, ...safePhoto } = photo;
          return safePhoto;
        });
        logPhotoDbEvent('debug', 'photo_subscription_snapshot', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
          photoCount: photos.length,
          sample: photos.slice(0, 5).map((photo) => ({
            id: summarizePrincipalForDbLog(photo.id),
            timestamp: photo.timestamp || null,
            userId: summarizePrincipalForDbLog(photo.userId),
            variantStatus: photo.variantStatus || null,
            hasThumbnail: Boolean(photo.thumbnailUrl),
            hasViewer: Boolean(photo.viewerUrl),
          })),
        });
        callback(safePhotos);
        Promise.resolve(resolveGroupPhotoMediaFn({ tourId: validatedTourId, photos: safePhotos }))
          .then((hydrated) => {
            if (currentGeneration === generation) callback(hydrated);
          })
          .catch((error) => {
            if (currentGeneration === generation) {
              logPhotoDbEvent('warn', 'photo_subscription_media_resolution_failed', {
                visibility: 'group',
                tourId: summarizePrincipalForDbLog(validatedTourId),
                error: summarizeErrorForDbLog(error),
              });
            }
          });
      } catch (error) {
        logPhotoDbEvent('error', 'photo_subscription_snapshot_processing_failed', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
          error: summarizeErrorForDbLog(error),
        });
        callback([]); // Provide empty array as fallback
      }
    }, (error) => {
      generation += 1;
      logPhotoDbEvent('error', 'photo_subscription_failed', {
        visibility: 'group',
        tourId: summarizePrincipalForDbLog(validatedTourId),
        error: summarizeErrorForDbLog(error),
      });
      callback([]); // Provide empty array on error
    });

    return () => {
      generation += 1;
      try {
        logPhotoDbEvent('debug', 'photo_subscription_stop', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
        });
        unsubscribe();
      } catch (error) {
        logPhotoDbEvent('warn', 'photo_subscription_unsubscribe_failed', {
          visibility: 'group',
          tourId: summarizePrincipalForDbLog(validatedTourId),
          error: summarizeErrorForDbLog(error),
        });
      }
    };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_subscription_setup_failed', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(tourId),
      error: summarizeErrorForDbLog(error),
    });
    return () => {};
  }
};

const subscribeToPrivatePhotos = (
  tourId,
  ownerId,
  callback,
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    onValueFn = onValue,
    queryFn = query,
    orderByChildFn = orderByChild,
    limitToLastFn = limitToLast,
    limit = LIVE_PHOTOS_WINDOW,
    resolvePrivatePhotoMediaFn = resolvePrivatePhotoMedia,
  } = {},
) => {
  try {
    if (!tourId || !ownerId || typeof callback !== 'function') {
      logPhotoDbEvent('warn', 'photo_subscription_private_skipped_invalid_args', {
        hasTourId: Boolean(tourId),
        hasOwnerId: Boolean(ownerId),
        hasCallback: typeof callback === 'function',
      });
      return () => {};
    }

    if (!realtimeDbInstance) {
      logPhotoDbEvent('warn', 'photo_subscription_db_unavailable', {
        visibility: 'private',
        tourId: summarizePrincipalForDbLog(tourId),
        ownerId: summarizePrincipalForDbLog(ownerId),
      });
      return () => {};
    }

    const ownerScope = ownerId.trim();
    if (!ownerScope) {
      logPhotoDbEvent('warn', 'photo_subscription_private_skipped_empty_owner', {
        tourId: summarizePrincipalForDbLog(tourId),
      });
      return () => {};
    }
    const ownerScopeKey = sanitizeRealtimeKeySegment(ownerScope);

    const photosRef = dbRefFn(realtimeDbInstance, `private_tour_photos/${tourId}/${ownerScopeKey}`);
    const liveLimit = sanitizePageLimit(limit || LIVE_PHOTOS_WINDOW);
    const photosQuery = queryFn(photosRef, orderByChildFn('timestamp'), limitToLastFn(liveLimit));

    logPhotoDbEvent('debug', 'photo_subscription_start', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerScope),
      ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
      liveLimit,
    });

    let generation = 0;
    const unsubscribe = onValueFn(photosQuery, async (snapshot) => {
      const currentGeneration = ++generation;
      try {
        let photos = mapSnapshotToPhotos(snapshot, { ownerScope });
        sortPhotosDescending(photos);
        photos = await resolvePrivatePhotoMediaFn({ tourId, ownerKey: ownerScopeKey, photos });
        if (currentGeneration !== generation) return;
        logPhotoDbEvent('debug', 'photo_subscription_snapshot', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
          ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
          photoCount: photos.length,
          sample: photos.slice(0, 5).map((photo) => ({
            id: summarizePrincipalForDbLog(photo.id),
            timestamp: photo.timestamp || null,
            userId: summarizePrincipalForDbLog(photo.userId),
            privateOwnerId: summarizePrincipalForDbLog(photo.privateOwnerId),
            variantStatus: photo.variantStatus || null,
            hasThumbnail: Boolean(photo.thumbnailUrl),
            hasViewer: Boolean(photo.viewerUrl),
          })),
        });
        callback(photos);
      } catch (error) {
        logPhotoDbEvent('error', 'photo_subscription_snapshot_processing_failed', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
          error: summarizeErrorForDbLog(error),
        });
        callback([]);
      }
    }, (error) => {
      logPhotoDbEvent('error', 'photo_subscription_failed', {
        visibility: 'private',
        tourId: summarizePrincipalForDbLog(tourId),
        ownerId: summarizePrincipalForDbLog(ownerScope),
        error: summarizeErrorForDbLog(error),
      });
      callback([]);
    });

    return () => {
      generation += 1;
      try {
        logPhotoDbEvent('debug', 'photo_subscription_stop', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
        });
        unsubscribe();
      } catch (error) {
        logPhotoDbEvent('warn', 'photo_subscription_unsubscribe_failed', {
          visibility: 'private',
          tourId: summarizePrincipalForDbLog(tourId),
          ownerId: summarizePrincipalForDbLog(ownerScope),
          error: summarizeErrorForDbLog(error),
        });
      }
    };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_subscription_setup_failed', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      error: summarizeErrorForDbLog(error),
    });
    return () => {};
  }
};

/**
 * Delete a photo from a group album
 * Only the photo owner can delete their photos
 * @param {string} tourId - Tour ID
 * @param {string} photoId - Photo ID
 * @param {string} requestingUserId - UID of the user requesting the deletion (for ownership verification)
 * @param {Object} options - Optional dependency injection for testing
 */
const deleteGroupPhoto = async (
  tourId,
  photoId,
  requestingUserId,
  {
    authInstance = auth,
    fetchFn = fetch,
    endpoint = buildGroupPhotoEndpointUrl(GROUP_DELETE_FUNCTION_NAME, authInstance),
    appCheckTokenFn = getCurrentAppCheckToken,
  } = {}
) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedPhotoId = validatePhotoId(photoId);
    if (!requestingUserId || typeof requestingUserId !== 'string') {
      throw new Error('User ID is required to delete a photo');
    }
    if (!endpoint) throw new Error('Group photo delete endpoint is unavailable');
    const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId: validatedTourId, photoId: validatedPhotoId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      if (payload?.reason === 'NOT_OWNER') throw new Error('You can only delete your own photos');
      throw new Error('Photo could not be deleted');
    }
    return { success: true };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_delete_failed', {
      visibility: 'group',
      tourId: summarizePrincipalForDbLog(tourId),
      photoId: summarizePrincipalForDbLog(photoId),
      requestingUserId: summarizePrincipalForDbLog(requestingUserId),
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};

/**
 * Delete a photo from a private album
 */
const deletePrivatePhoto = async (
  tourId,
  ownerId,
  photoId,
  {
    authInstance = auth,
    fetchFn = fetch,
    endpoint = buildPrivatePhotoEndpointUrl(PRIVATE_DELETE_FUNCTION_NAME, authInstance),
    appCheckTokenFn = getCurrentAppCheckToken,
  } = {}
) => {
  if (!tourId || !ownerId || !photoId) {
    throw new Error('Missing delete parameters');
  }

  try {
    const ownerScopeKey = sanitizeRealtimeKeySegment(ownerId);
    logPhotoDbEvent('info', 'photo_delete_start', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
      photoId: summarizePrincipalForDbLog(photoId),
    });

    if (!endpoint) throw new Error('Private photo delete endpoint is unavailable');
    const authHeaders = await buildGroupPhotoAuthHeaders(authInstance, appCheckTokenFn);
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tourId, photoId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      throw new Error(payload?.reason === 'NOT_AUTHORIZED'
        ? 'You no longer have access to this tour'
        : 'Private photo could not be deleted');
    }

    logPhotoDbEvent('info', 'photo_delete_success', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      ownerKey: summarizePrincipalForDbLog(ownerScopeKey),
      photoId: summarizePrincipalForDbLog(photoId),
    });
    return { success: true };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_delete_failed', {
      visibility: 'private',
      tourId: summarizePrincipalForDbLog(tourId),
      ownerId: summarizePrincipalForDbLog(ownerId),
      photoId: summarizePrincipalForDbLog(photoId),
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};

const updatePhotoCaption = async (
  { tourId, photoId, userId, ownerId, caption, visibility = 'group' },
  {
    realtimeDbInstance = realtimeDbModular,
    dbRefFn = databaseRef,
    updateFn = update,
    serverTimestampFn = serverTimestamp,
    nowFn = Date.now,
  } = {},
) => {
  try {
    const validatedTourId = validateTourId(tourId);
    const validatedPhotoId = validatePhotoId(photoId);
    const resolvedOwnerId = validateUserId(ownerId || userId);
    const resolvedOwnerKey = sanitizeRealtimeKeySegment(resolvedOwnerId);
    const validatedCaption = validateCaption(caption);
    const validatedVisibility = validateVisibility(visibility);

    const basePath = validatedVisibility === 'private'
      ? `private_tour_photos/${validatedTourId}/${resolvedOwnerKey}/${validatedPhotoId}`
      : `group_tour_photos/${validatedTourId}/${validatedPhotoId}`;

    logPhotoDbEvent('info', 'photo_caption_update_start', {
      visibility: validatedVisibility,
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
      ownerId: summarizePrincipalForDbLog(resolvedOwnerId),
      ownerKey: summarizePrincipalForDbLog(resolvedOwnerKey),
      captionLength: validatedCaption.length,
    });

    const photoRef = dbRefFn(realtimeDbInstance, basePath);
    await updateFn(photoRef, {
      caption: validatedCaption,
      captionUpdatedAt: resolveRealtimeTimestamp(serverTimestampFn, nowFn),
      captionEditedBy: resolvedOwnerId,
    });

    logPhotoDbEvent('info', 'photo_caption_update_success', {
      visibility: validatedVisibility,
      tourId: summarizePrincipalForDbLog(validatedTourId),
      photoId: summarizePrincipalForDbLog(validatedPhotoId),
      ownerId: summarizePrincipalForDbLog(resolvedOwnerId),
      captionLength: validatedCaption.length,
    });

    return { success: true };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_caption_update_failed', {
      visibility,
      tourId: summarizePrincipalForDbLog(tourId),
      photoId: summarizePrincipalForDbLog(photoId),
      ownerId: summarizePrincipalForDbLog(ownerId || userId),
      captionLength: typeof caption === 'string' ? caption.trim().length : 0,
      error: summarizeErrorForDbLog(error),
    });
    throw error;
  }
};


const uploadPhotoDirect = async (payload = {}) => {
  // Historical offline-queue API name: this delegates to uploadPhoto, which
  // always uses the authenticated, App-Check-protected media Functions.
  let directDiagnostics = {};

  try {
    const {
      uri,
      tourId,
      userId,
      ownerId,
      caption = '',
      visibility = 'group',
      uploaderName = 'Tour Member',
      optimizationMetrics = null,
      onProgress = null,
      localAssets = null,
      metadata = null,
      idempotencyKey = null,
    } = payload;

    const resolvedLocalAssets = localAssets && typeof localAssets === 'object' ? localAssets : {};
    const resolvedMetadata = metadata && typeof metadata === 'object' ? metadata : {};
    const sourceUri = uri || resolvedLocalAssets.sourceUri;
    const sourceCaption = (typeof caption === 'string' && caption.length > 0)
      ? caption
      : (resolvedMetadata.caption ?? '');
    const sourceOptimizationMetrics = optimizationMetrics || resolvedLocalAssets.optimizationMetrics || null;

    const resolvedOwnerId = ownerId || userId;
    directDiagnostics = {
      payloadVersion: 2,
      visibility,
      tourId: summarizePrincipalForDbLog(tourId),
      userId: summarizePrincipalForDbLog(userId),
      ownerId: summarizePrincipalForDbLog(resolvedOwnerId),
      ownerKey: summarizePrincipalForDbLog(
        typeof resolvedOwnerId === 'string' && resolvedOwnerId.trim()
          ? sanitizeRealtimeKeySegment(resolvedOwnerId)
          : null
      ),
      hasIdempotencyKey: Boolean(idempotencyKey),
      idempotencyKey: summarizePrincipalForDbLog(idempotencyKey),
      hasSourceUri: Boolean(sourceUri),
      sourceUri: summarizeUriForDbLog(sourceUri),
      hasLocalAssets: Boolean(localAssets),
      localAssetKeys: Object.keys(resolvedLocalAssets),
    };
    logPhotoDbEvent('info', 'photo_upload_direct_start', directDiagnostics);

    const validatedTourId = validateTourId(tourId);
    const validatedUserId = validateUserId(resolvedOwnerId);
    const validatedCaption = validateCaption(sourceCaption);
    const validatedVisibility = validateVisibility(visibility);
    const normalizedIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim()
      ? idempotencyKey.trim().slice(0, IDEMPOTENCY_KEY_MAX_LENGTH)
      : null;

    if (!normalizedIdempotencyKey) {
      logPhotoDbEvent('warn', 'photo_upload_direct_missing_idempotency_key', directDiagnostics);
      return { success: false, error: 'idempotencyKey is required for photo uploads' };
    }

    const data = await uploadPhoto(sourceUri, validatedTourId, validatedUserId, validatedCaption, {
      visibility: validatedVisibility,
      uploaderName,
      optimizationMetrics: sourceOptimizationMetrics,
      onProgress,
      idempotencyKey: normalizedIdempotencyKey,
    });

    return { success: true, data };
  } catch (error) {
    logPhotoDbEvent('error', 'photo_upload_direct_failed', {
      diagnostics: directDiagnostics,
      error: summarizeErrorForDbLog(error),
    });
    return { success: false, error: error?.message || 'Photo upload failed' };
  }
};

module.exports = {
  uploadPhoto,
  uploadPhotoDirect,
  fetchTourPhotosPage,
  fetchPrivatePhotosPage,
  resolveGroupPhotoMedia,
  subscribeToTourPhotos,
  subscribeToPrivatePhotos,
  deleteGroupPhoto,
  deletePrivatePhoto,
  updatePhotoCaption,
  createBlob,
  resolvePrivatePhotoMedia,
  buildGroupPhotoEndpointUrl,
  buildPrivatePhotoEndpointUrl,
  buildGroupPhotoAuthHeaders,
};
